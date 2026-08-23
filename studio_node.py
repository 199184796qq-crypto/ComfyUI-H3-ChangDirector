# -*- coding: utf-8 -*-
"""H3 漫剧导演台·一体节点（H3DirectorStudio）
单节点内部完成多段编排：编码参考图+提示词 → 采样 → 解码 → 存段视频/尾帧 → 合并。
段间文件接力（tail_segN.png），配置哈希匹配的段自动跳过，可断点续跑。
"""
import os
import gc
import re
import sys
import math
import json
import glob
import inspect
import importlib
import hashlib
import hmac
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from urllib.parse import quote, urlsplit, urlunsplit

import numpy as np
import requests
import torch
from PIL import Image
from safetensors.torch import load as safetensors_load, save as safetensors_save

import folder_paths
import comfy.samplers
import comfy.utils
import comfy.model_management
import latent_preview
from comfy_extras.nodes_custom_sampler import Noise_RandomNoise, Guider_Basic
from comfy_extras.nodes_minimax_h3 import (
    MiniMaxH3ReferenceToVideo,
    MiniMaxH3ImageToVideo,
    MiniMaxH3AddGuide,
)
from comfy_extras.nodes_audio import vae_decode_audio

CATEGORY = "H3 长序列分镜融合台"
OUTPUT_DIR = folder_paths.get_output_directory()
INPUT_DIR = folder_paths.get_input_directory()
VIDEO_DIR = os.path.join(OUTPUT_DIR, "video")
PROJECT_ROOT = os.path.join(VIDEO_DIR, "h3director")
FPS = 24
CACHE_SCHEMA = 12  # v2.26.0：段级 Add Guide 时间锚点

# 段级生成模式。multi_ref 保持旧版 Ref2VA 多参考图行为；其余模式走
# MiniMaxH3ImageToVideo，并由本段 refs 的顺序提供首帧/尾帧。
GENERATION_MODES = {"multi_ref", "text_to_video", "first_frame", "first_last_frame", "last_frame"}
MOTION_CONTEXT_SOURCES = {"local_latent", "upload_latent", "aliyun_oss", "video"}

SEGMENT_ASPECT_RATIOS = {
    "1:1 (Square)": (1, 1),
    "2:3 (Portrait Photo)": (2, 3),
    "3:2 (Photo)": (3, 2),
    "3:4 (Portrait Standard)": (3, 4),
    "4:3 (Standard)": (4, 3),
    "9:16 (Portrait Widescreen)": (9, 16),
    "16:9 (Widescreen)": (16, 9),
    "21:9 (Ultrawide)": (21, 9),
}


def _segment_resolution(seg_cfg, default_width, default_height):
    """Return this segment's effective dimensions using ResolutionSelector math."""
    seg_cfg = seg_cfg or {}
    aspect = str(seg_cfg.get("aspect_ratio") or "").strip()
    if aspect in SEGMENT_ASPECT_RATIOS:
        try:
            megapixels = float(seg_cfg.get("megapixels", 0.5))
        except (TypeError, ValueError):
            megapixels = 0.5
        megapixels = math.floor(max(0.1, min(16.0, megapixels)) * 10 + 0.5) / 10
        try:
            multiple = int(seg_cfg.get("multiple", 32))
        except (TypeError, ValueError):
            multiple = 32
        multiple = max(8, min(128, multiple))
        w_ratio, h_ratio = SEGMENT_ASPECT_RATIOS[aspect]
        scale = math.sqrt(megapixels * 1024 * 1024 / (w_ratio * h_ratio))
        width = round(w_ratio * scale / multiple) * multiple
        height = round(h_ratio * scale / multiple) * multiple
        return max(multiple, width), max(multiple, height)

    # 旧工作流没有 selector 字段，继续尊重原先保存的 width/height。
    try:
        width = int(seg_cfg.get("width") or default_width)
        height = int(seg_cfg.get("height") or default_height)
    except (TypeError, ValueError):
        width, height = int(default_width), int(default_height)
    return max(32, width), max(32, height)


def _generation_mode(seg_cfg):
    """读取兼容旧工作流的段级生成模式。旧段一律保持多参生视频。"""
    value = str((seg_cfg or {}).get("generation_mode") or "multi_ref").strip()
    return value if value in GENERATION_MODES else "multi_ref"


def _motion_context_source(seg_cfg):
    """读取 Motion Context 来源；旧工作流一律保留本地自动 latent 续接。"""
    value = str((seg_cfg or {}).get("motion_context_source") or "local_latent").strip()
    return value if value in MOTION_CONTEXT_SOURCES else "local_latent"


def _motion_context_local_index(seg_cfg, default_index=0):
    """Return the user-selected local Motion Context source slot.

    Index 0 deliberately means “start a fresh local chain”: no prior latent
    is loaded, and the generated AV latent is saved to clip_00001.
    """
    try:
        value = int((seg_cfg or {}).get("motion_context_index", default_index))
    except (TypeError, ValueError):
        value = int(default_index)
    return max(0, min(9998, value))


def _oss_config(value):
    if not isinstance(value, dict):
        raise ValueError("[H3导演台] 选择‘latent 延续：阿里云’时，必须连接‘阿里云 OSS 配置（REST）’节点。")
    config = dict(value)
    required = ("endpoint", "region", "bucket", "access_key_id", "access_key_secret")
    missing = [name for name in required if not str(config.get(name) or "").strip()]
    if missing:
        raise ValueError("[H3导演台] 阿里云 OSS 配置缺少：%s" % ", ".join(missing))
    config["use_system_proxy"] = bool(config.get("use_system_proxy", False))
    prefix = str(config.get("object_key") or "H3").replace("\\", "/").strip().strip("/")
    if not prefix or any(part in ("", ".", "..") for part in prefix.split("/")):
        raise ValueError("[H3导演台] object_key 必须是有效的 OSS 目录，例如 H3 或 project_a/H3。")
    config["object_key"] = prefix + "/"
    return config


def _oss_object_key(config, clip_index):
    return "%sclip_%05d.safetensors" % (config["object_key"], int(clip_index))


def _oss_endpoint_url(config, key):
    endpoint = str(config["endpoint"]).strip()
    endpoint = endpoint if "://" in endpoint else "https://" + endpoint
    parts = urlsplit(endpoint)
    if not parts.scheme or not parts.netloc or parts.path not in ("", "/"):
        raise ValueError("[H3导演台] OSS endpoint 应为区域端点，例如 https://oss-cn-beijing.aliyuncs.com。")
    bucket = str(config["bucket"]).strip()
    host = parts.netloc if parts.netloc.startswith(bucket + ".") else bucket + "." + parts.netloc
    return urlunsplit((parts.scheme, host, "/" + quote(key, safe="/-_.~"), "", ""))


def _oss_signing_key(secret, date, region):
    key = hmac.new(("aliyun_v4" + secret).encode("utf-8"), date.encode("utf-8"), hashlib.sha256).digest()
    key = hmac.new(key, region.encode("utf-8"), hashlib.sha256).digest()
    key = hmac.new(key, b"oss", hashlib.sha256).digest()
    return hmac.new(key, b"aliyun_v4_request", hashlib.sha256).digest()


def _oss_headers(method, key, config, content_type=""):
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    date = timestamp[:8]
    headers = {"x-oss-content-sha256": "UNSIGNED-PAYLOAD", "x-oss-date": timestamp}
    if content_type:
        headers["Content-Type"] = content_type
    if str(config.get("security_token") or "").strip():
        headers["x-oss-security-token"] = str(config["security_token"]).strip()
    signed = sorted((name.lower(), " ".join(value.strip().split())) for name, value in headers.items()
                    if name.lower().startswith("x-oss-") or name.lower() in ("content-type", "content-md5"))
    canonical_headers = "".join("%s:%s\n" % item for item in signed)
    canonical_uri = quote("/%s/%s" % (config["bucket"], key), safe="/-_.~")
    canonical_request = "%s\n%s\n\n%s\n\nUNSIGNED-PAYLOAD" % (method, canonical_uri, canonical_headers)
    scope = "%s/%s/oss/aliyun_v4_request" % (date, config["region"])
    string_to_sign = "OSS4-HMAC-SHA256\n%s\n%s\n%s" % (
        timestamp, scope, hashlib.sha256(canonical_request.encode("utf-8")).hexdigest())
    signature = hmac.new(
        _oss_signing_key(str(config["access_key_secret"]), date, str(config["region"])),
        string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    headers["Authorization"] = "OSS4-HMAC-SHA256 Credential=%s/%s,Signature=%s" % (
        config["access_key_id"], scope, signature)
    return headers


def _oss_request(method, key, config, content_type="", **kwargs):
    session = requests.Session()
    session.trust_env = config["use_system_proxy"]
    response = session.request(
        method, _oss_endpoint_url(config, key), headers=_oss_headers(method, key, config, content_type),
        timeout=(10, 600), **kwargs)
    if not response.ok:
        detail = response.text[:1000].strip()
        response.close()
        raise RuntimeError("[H3导演台] OSS %s %s 失败（HTTP %d）：%s" % (
            method, key, response.status_code, detail))
    return response


def _h3_av_streams(samples):
    parts = list(samples.unbind()) if hasattr(samples, "unbind") else list(samples) if isinstance(samples, (tuple, list)) else []
    if len(parts) < 2:
        raise ValueError("[H3导演台] 无法保存阿里云 latent：当前输出不是 H3 AV latent。")
    return parts[0].cpu().contiguous(), parts[1].cpu().contiguous()


def _oss_save_h3_latent(samples, config, clip_index):
    video, audio = _h3_av_streams(samples)
    key = _oss_object_key(config, clip_index)
    payload = safetensors_save({"video": video, "audio": audio},
                               metadata={"format": "h3_motion_context_av_v1"})
    response = _oss_request("PUT", key, config, content_type="application/octet-stream", data=payload)
    etag = response.headers.get("ETag", "").strip('"')
    response.close()
    return key, etag


def _oss_load_h3_latent(config, clip_index):
    key = _oss_object_key(config, clip_index)
    response = _oss_request("GET", key, config)
    payload = response.content
    response.close()
    data = safetensors_load(payload)
    if "video" not in data or "audio" not in data:
        raise ValueError("[H3导演台] OSS 对象 %s 不是有效的 H3 Motion Context latent。" % key)
    return {"samples": [data["video"], data["audio"]]}, key


def _oss_object_etag(config, clip_index):
    key = _oss_object_key(config, clip_index)
    response = _oss_request("HEAD", key, config)
    etag = response.headers.get("ETag", "").strip('"')
    response.close()
    return etag


def _log(msg):
    try:
        print(msg)
    except Exception:
        pass


# 用户友好的参考图引用写法 -> 模型原生 <Picture N> 标签
_AT_REF_PATTERNS = [
    (re.compile(r"[@＠]图\s*(\d+)"), r"<Picture \1>"),          # @图1 / ＠图1
    (re.compile(r"[@＠][Pp]icture\s*(\d+)"), r"<Picture \1>"),   # @picture1
    (re.compile(r"[@＠][Ii][Mm][Aa]?[Gg][Ee]?\s*(\d+)"), r"<Picture \1>"),  # @image1 / @img1
    (re.compile(r"【图\s*(\d+)】"), r"<Picture \1>"),            # 【图1】
]

# 用户友好的参考音色引用写法 -> 模型原生 <Audio N> 标签
_AT_AUDIO_REF_PATTERNS = [
    (re.compile(r"[@＠]音\s*(\d+)"), r"<Audio \1>"),            # @音1 / ＠音1
    (re.compile(r"[@＠][Aa]udio\s*(\d+)"), r"<Audio \1>"),      # @audio1
    (re.compile(r"【音\s*(\d+)】"), r"<Audio \1>"),              # 【音1】
]


def _convert_at_refs(prompt):
    if not prompt:
        return prompt
    out = prompt
    for pat, rep in _AT_REF_PATTERNS:
        out = pat.sub(rep, out)
    img_changed = out != prompt
    for pat, rep in _AT_AUDIO_REF_PATTERNS:
        out = pat.sub(rep, out)
    if img_changed or out != prompt:
        _log("[H3导演台] 提示词引用转换: @图N -> <Picture N>, @音N -> <Audio N>")
    return out


def _is_same_image(a, b):
    """两张 IMAGE 张量内容是否一致（用于参考图去重）。"""
    try:
        return a.shape == b.shape and bool((a == b).all())
    except Exception:
        return False


def _latest(pattern):
    files = glob.glob(pattern)
    return max(files, key=os.path.getmtime) if files else None


# 三个界面独立命名（v2.3 视频 / v2.11 文本）：各页产出互不覆盖
_SEG_NAME = {"create": "漫剧_seg%d_00001_", "video": "漫剧v_seg%d_00001_", "text": "漫剧t_seg%d_00001_"}
_TAIL_NAME = {"create": "tail_seg%d_00001_.png", "video": "tailv_seg%d_00001_.png", "text": "tailt_seg%d_00001_.png"}


def _safe_project_id(value):
    value = re.sub(r"[^0-9A-Za-z_-]+", "_", str(value or "").strip())[:80].strip("_")
    return value or "default"


def _project_dir(project_id):
    return os.path.join(PROJECT_ROOT, _safe_project_id(project_id))


def _seg_video(seg, mode="create", project_id="default"):
    return os.path.join(_project_dir(project_id), (_SEG_NAME.get(mode, _SEG_NAME["create"]) % seg) + ".mp4")


def _seg_meta(seg, mode="create", project_id="default"):
    return os.path.join(_project_dir(project_id), (_SEG_NAME.get(mode, _SEG_NAME["create"]) % seg) + ".json")


def _seg_tail(seg, mode="create", project_id="default"):
    return os.path.join(_project_dir(project_id), _TAIL_NAME.get(mode, _TAIL_NAME["create"]) % seg)


def _resolve_input(name):
    """input 目录文件路径解析（兼容 ComfyUI 的 [input] 标注语法）。"""
    return folder_paths.get_annotated_filepath(name, INPUT_DIR)


def _input_signature(name):
    if not name:
        return None
    try:
        path = _resolve_input(name)
        st = os.stat(path)
        return {"name": name, "size": st.st_size, "mtime_ns": st.st_mtime_ns}
    except (OSError, ValueError):
        return {"name": name, "missing": True}


def _path_signature(path):
    try:
        st = os.stat(path)
        return {"path": os.path.basename(path), "size": st.st_size, "mtime_ns": st.st_mtime_ns}
    except OSError:
        return {"path": os.path.basename(path), "missing": True}


def _sigmas_signature(sigmas):
    """Create a stable cache signature for an optional external SIGMAS chain."""
    if sigmas is None:
        return None
    if not isinstance(sigmas, torch.Tensor):
        return {"invalid_type": type(sigmas).__name__}
    values = sigmas.detach().to(device="cpu", dtype=torch.float32).contiguous()
    return {
        "shape": list(values.shape),
        "dtype": str(sigmas.dtype),
        "sha256": hashlib.sha256(values.numpy().tobytes()).hexdigest(),
    }


def _safe_export_prefix(value):
    """Sanitize a user filename prefix using Windows-compatible rules."""
    prefix = str(value or "").strip().strip('"').strip("'") or "ComfyUI"
    prefix = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", prefix).strip(" ._")
    return prefix or "ComfyUI"


def _resolve_export_directory(value):
    raw = str(value or "").strip().strip('"').strip("'")
    if not raw:
        return None
    if raw.lower() in ("output", "comfyui/output", "comfyui\\output"):
        return os.path.realpath(OUTPUT_DIR)
    raw = os.path.expanduser(raw)
    return os.path.realpath(raw if os.path.isabs(raw) else os.path.join(os.getcwd(), raw))


def _export_signature(output_dir, filename_prefix, seg_idx, video_short_side):
    directory = _resolve_export_directory(output_dir)
    if directory is None:
        return None
    return _config_hash({
        "directory": directory,
        "prefix": _safe_export_prefix(filename_prefix),
        "segment": int(seg_idx),
        "video_short_side": max(1, int(video_short_side)),
        "rule": "prefix_segment_short_side_timestamp_v5",
    })


def _export_segment_video(source_path, output_dir, filename_prefix, seg_idx, video_short_side,
                          previous_meta=None, force=False):
    """Mirror a canonical segment MP4 into the user's delivery directory.

    The metadata makes cache hits idempotent: the same segment is not copied
    repeatedly, while a changed directory/prefix or a deleted delivery file is
    repaired from the canonical cached MP4 without rerunning the H3 model.
    """
    directory = _resolve_export_directory(output_dir)
    if directory is None:
        return None, None, False
    signature = _export_signature(output_dir, filename_prefix, seg_idx, video_short_side)
    prior = previous_meta if isinstance(previous_meta, dict) else {}
    prior_path = str(prior.get("export_path") or "")
    if (not force and prior.get("export_signature") == signature
            and prior_path and os.path.isfile(prior_path)):
        return prior_path, signature, False

    os.makedirs(directory, exist_ok=True)
    prefix = _safe_export_prefix(filename_prefix)
    # 交付文件名使用四位当前段号、当前段分辨率的短边（宽、高中的较小值）和时间戳。
    # 同一分钟内同名的重新导出仍由下方递增序号确保不会覆盖。
    stem = "%s_%04d_%d_%s" % (
        prefix,
        max(1, int(seg_idx)),
        max(1, int(video_short_side)),
        datetime.now().strftime("%Y%m%d_%H_%M"),
    )
    target = os.path.join(directory, stem + ".mp4")
    suffix = 2
    while os.path.exists(target):
        target = os.path.join(directory, "%s_%d.mp4" % (stem, suffix))
        suffix += 1
    shutil.copy2(source_path, target)
    return target, signature, True


def _motion_context_classes():
    """Return the installed Motion Context node classes at execution time.

    The dependency is looked up lazily from ComfyUI's registered node map so
    this plugin always executes the installed Motion Context implementation
    instead of carrying a stale copy of its continuation algorithm.  Newer
    MultiRef builds intentionally hide the four classic IDs when the base pack
    is present; if the base IDs are absent, recover the matching classes from
    one of MultiRef's registered extension nodes.
    """
    import nodes as comfy_nodes

    names = (
        "MiniMaxH3MotionContext",
        "MiniMaxH3MotionContextTrim",
        "MiniMaxH3MotionContextSaveLatent",
        "MiniMaxH3MotionContextLoadLatent",
    )
    registry = comfy_nodes.NODE_CLASS_MAPPINGS
    if all(name in registry for name in names):
        return tuple(registry[name] for name in names)

    # ComfyUI-H3-Motion-Context-MultiRef registers these extension-only IDs.
    # Their classes live in the same Python module as its compatible classic
    # implementation, even when __init__.py suppresses the duplicate IDs.
    multiref_probes = (
        "MiniMaxH3OptionalReferenceImage",
        "MiniMaxH3CustomKeyframes",
        "MiniMaxH3ExistingVideoMaskedContext",
    )
    for probe in multiref_probes:
        probe_class = registry.get(probe)
        if probe_class is None:
            continue
        module_name = getattr(probe_class, "__module__", "")
        module = sys.modules.get(module_name)
        if module is None and module_name:
            try:
                module = importlib.import_module(module_name)
            except Exception:
                module = None
        if module is not None and all(hasattr(module, name) for name in names):
            return tuple(getattr(module, name) for name in names)

    missing = [name for name in names if name not in registry]
    raise RuntimeError(
        "[H3导演台] Motion Context 依赖未加载：%s。请安装并启用 "
        "ComfyUI-H3-Motion-Context 或 "
        "ComfyUI-H3-Motion-Context-MultiRef，然后完全重启 ComfyUI。"
        % ", ".join(missing)
    )


def _motion_context_frames_from_latent(context_latent, vae, context_length):
    """Decode pixel frames required by native/MultiRef Motion Context.

    The base implementation can use the previous AV latent directly for both
    picture and sound.  MultiRef's native-guide implementation still requires
    IMAGE frames for the visual guide, while accepting the latent for audio.
    """
    if not isinstance(context_latent, dict) or "samples" not in context_latent:
        raise ValueError("[H3导演台] Motion Context latent 缺少 samples。")
    video_latent = context_latent["samples"]
    if getattr(video_latent, "is_nested", False):
        video_latent = video_latent.unbind()[0]
    elif isinstance(video_latent, (tuple, list)):
        if not video_latent:
            raise ValueError("[H3导演台] Motion Context latent 为空。")
        video_latent = video_latent[0]
    if getattr(video_latent, "ndim", 0) == 4:
        video_latent = video_latent.unsqueeze(0)
    frames = vae.decode(video_latent)
    if getattr(frames, "ndim", 0) == 5:
        frames = frames[0]
    if getattr(frames, "ndim", 0) != 4:
        raise ValueError(
            "[H3导演台] Motion Context latent 解码后应为 [T,H,W,C]，实际为 %s。"
            % (tuple(getattr(frames, "shape", ())),)
        )
    return frames[-max(1, int(context_length)):]


def _motion_context_apply(MotionClass, conditioning, vae, latent,
                          context_length, audio_context_length,
                          context_frames=None, context_latent=None,
                          audio_vae=None, context_audio=None):
    """Call either the base or MultiRef Motion Context signature safely."""
    parameters = inspect.signature(MotionClass.apply).parameters
    requires_frames = (
        "context_frames" in parameters
        and parameters["context_frames"].default is inspect.Parameter.empty
    )
    if context_frames is None and requires_frames:
        if context_latent is None:
            raise ValueError(
                "[H3导演台] 当前 Motion Context 实现需要上下文画面帧。"
            )
        context_frames = _motion_context_frames_from_latent(
            context_latent, vae, context_length)

    # MultiRef's native timeline mode requires the audio window not to exceed
    # the visual guide.  The base pack accepts its historic 22/24 default.
    effective_audio_length = int(audio_context_length)
    if "audio_mode" in parameters:
        effective_audio_length = min(
            effective_audio_length, max(1, int(context_length)))

    values = {
        "conditioning": conditioning,
        "vae": vae,
        "latent": latent,
        "context_frames": context_frames,
        "context_length": int(context_length),
        "encode_mode": "video",
        "anchor_mode": "head",
        "crop": "disabled",
        "audio_context_length": effective_audio_length,
        "audio_mode": "timeline",
        "context_latent": context_latent,
        "audio_vae": audio_vae,
        "context_audio": context_audio,
    }
    kwargs = {name: values[name] for name in parameters if name in values}
    result = MotionClass().apply(**kwargs)
    if not isinstance(result, (tuple, list)) or len(result) < 2:
        raise RuntimeError("[H3导演台] Motion Context 返回值格式不兼容。")
    return result[0], int(result[1])


def _motion_context_trim(TrimClass, images, trim_frames, audio, fps,
                         match_tail):
    """Normalize the base two-output and MultiRef four-output trim nodes."""
    result = TrimClass().trim(
        images, trim_frames, audio=audio, fps=fps, match_tail=match_tail)
    if not isinstance(result, (tuple, list)) or len(result) < 2:
        raise RuntimeError("[H3导演台] Motion Context Trim 返回值格式不兼容。")
    return result[0], result[1]


def _context_directory(value):
    """Resolve a user context directory like Motion Context Load Latent."""
    raw = str(value or "").strip().strip('"').strip("'") or "h3_context"
    return os.path.realpath(raw if os.path.isabs(raw) else os.path.join(OUTPUT_DIR, raw))


def _context_save_prefix(value):
    """Turn the Director's save-directory field into Save Latent's prefix."""
    raw = str(value or "").strip().strip('"').strip("'") or "h3_context"
    return os.path.join(raw, "clip")


def _context_slot_path(directory, clip_index):
    """Find the fixed Motion Context slot for a segment, if it exists."""
    folder = _context_directory(directory)
    if not os.path.isdir(folder):
        return None
    endings = ("_%05d.safetensors" % int(clip_index),
               "_clip%03d.safetensors" % int(clip_index))
    files = [os.path.join(folder, name) for name in os.listdir(folder)
             if name.endswith(endings)]
    return max(files, key=os.path.getmtime) if files else None


def _upstream_fingerprint(prompt, unique_id, input_name):
    if not isinstance(prompt, dict):
        return "unknown"
    node = prompt.get(str(unique_id)) or prompt.get(unique_id)
    if not isinstance(node, dict):
        return "unknown"

    prompt_ids = {str(k) for k in prompt}

    def visit(node_id, seen):
        key = str(node_id)
        if key in seen:
            return {"cycle": key}
        src = prompt.get(key) or prompt.get(node_id)
        if not isinstance(src, dict):
            return {"missing": key}
        seen = set(seen)
        seen.add(key)
        out = {"class_type": src.get("class_type"), "inputs": {}}
        for name, value in sorted((src.get("inputs") or {}).items()):
            if isinstance(value, list) and len(value) == 2 and str(value[0]) in prompt_ids:
                out["inputs"][name] = {"slot": value[1], "node": visit(value[0], seen)}
            elif isinstance(value, (str, int, float, bool)) or value is None:
                out["inputs"][name] = value
            else:
                out["inputs"][name] = repr(value)
        return out

    link = (node.get("inputs") or {}).get(input_name)
    if not (isinstance(link, list) and len(link) == 2):
        return "not_connected"
    payload = {"slot": link[1], "node": visit(link[0], set())}
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def _output_connected(prompt, unique_id, output_index):
    if not isinstance(prompt, dict):
        return False
    source_id = str(unique_id)
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        for value in (node.get("inputs") or {}).values():
            if isinstance(value, list) and len(value) == 2 \
                    and str(value[0]) == source_id and value[1] == output_index:
                return True
    return False


def _upstream_model_kind(prompt, unique_id, input_name="model"):
    """只读检查模型输入的上游节点，识别 FL2VA / Ref2VA。

    ComfyUI 的 MODEL 对象没有稳定公开的文件名属性；运行 prompt 图里则会保留
    UNETLoader 的模型文件名。这里只返回分类结果，不记录或输出上游字符串。
    """
    if not isinstance(prompt, dict):
        return "unknown"
    node = prompt.get(str(unique_id)) or prompt.get(unique_id)
    if not isinstance(node, dict):
        return "unknown"

    prompt_ids = {str(k) for k in prompt}
    texts = []

    def visit(node_id, seen):
        key = str(node_id)
        if key in seen:
            return
        src = prompt.get(key) or prompt.get(node_id)
        if not isinstance(src, dict):
            return
        seen = set(seen)
        seen.add(key)
        class_type = src.get("class_type")
        if isinstance(class_type, str):
            texts.append(class_type)
        for name, value in (src.get("inputs") or {}).items():
            if isinstance(name, str):
                texts.append(name)
            if isinstance(value, list) and len(value) == 2 and str(value[0]) in prompt_ids:
                visit(value[0], seen)
            elif isinstance(value, str):
                texts.append(value)

    link = (node.get("inputs") or {}).get(input_name)
    if not (isinstance(link, list) and len(link) == 2):
        return "not_connected"
    visit(link[0], set())
    marker = "\n".join(texts).lower()
    is_fl2va = any(x in marker for x in ("fl2va", "fl2v", "firstlast", "first_last"))
    is_ref2va = any(x in marker for x in ("ref2va", "ref2v", "reference_to_video"))
    if is_fl2va and not is_ref2va:
        return "fl2va"
    if is_ref2va and not is_fl2va:
        return "ref2va"
    return "unknown"


def _select_h3_task(primary_model_kind, has_optional_fl2va, has_references,
                    has_first_frame, prefer_fl2va):
    """决定本段使用 FL2VA 还是 Ref2VA；独立函数便于兼容性测试。"""
    fl2va_available = bool(has_optional_fl2va) or primary_model_kind == "fl2va"
    # 多参考模式允许主 model 直接接 FL2VA，采样仍走 FL2VA；不再因模型类型
    # 与参考素材同时存在而拦截。FL2VA 原生不接收多参考输入，故这些输入不会
    # 传给其采样器。
    if primary_model_kind == "fl2va":
        return "fl2va"
    if has_first_frame:
        if fl2va_available:
            return "fl2va"
        raise ValueError(
            "[H3导演台] 本段启用了硬首帧续接，但没有可用的 FL2VA 模型；"
            "请连接 fl2va_model，或把 FL2VA 直接连接到主 model。")
    if has_references:
        return "ref2va"
    if (prefer_fl2va and fl2va_available) or primary_model_kind == "fl2va":
        return "fl2va"
    return "ref2va"


REF_AUDIO_SR = 32000  # H3 audio_vae 原生采样率


def _load_audio_for_ref(path, seg_cfg, ffmpeg):
    """把自定义音频解码成 ComfyUI AUDIO 类型，供 MiniMaxH3ReferenceToVideo 的
    ref_audios 参考驱动（模型听着这段音频生成台词，口型原生同步——与 ffmpeg
    事后替换音轨有本质区别，后者口型必然对不上）。

    复用与 _write_segment_video 相同的裁剪语义：trim_start/end + keep/cut + offset。
    音频经 ffmpeg 输出 f32le PCM 到 stdout（新版 torchaudio 强制 torchcodec，
    Windows 难装，刻意不用），offset 以前导静音补齐。"""
    ts = max(0.0, float(seg_cfg.get("audio_trim_start") or 0))
    te = float(seg_cfg.get("audio_trim_end") or 0)
    mode = seg_cfg.get("audio_trim_mode", "keep")
    off = max(0.0, float(seg_cfg.get("audio_offset") or 0))
    mid_cut = mode == "cut" and ts > 0 and te > ts

    args = [ffmpeg, "-y"]
    if mid_cut:
        # 删除 [ts,te] 保留首尾（同 _write_segment_video 的 _cut_pre 链）
        fc = ("[0:a]asplit=2[cax][cay];[cax]atrim=0:%.3f[cap];"
              "[cay]atrim=start=%.3f[caq];[cap][caq]concat=n=2:v=0:a=1[cac];"
              "[cac]aformat=sample_rates=%d:channel_layouts=stereo[aout]" % (ts, te, REF_AUDIO_SR))
        args += ["-i", path, "-filter_complex", fc, "-map", "[aout]"]
    else:
        # 与 _write_segment_video 的 ca_in 语义逐条对应（-ss/-t 均在 -i 之前）
        if mode == "cut":
            if te > 0:
                args += ["-ss", "%.3f" % te]     # 删除 [0,te] = 保留 [te,尾]
            elif ts > 0:
                args += ["-t", "%.3f" % ts]      # 删除 [ts,尾] = 保留 [0,ts]
        else:
            if ts > 0:
                args += ["-ss", "%.3f" % ts]
            if te > ts and te > 0:
                args += ["-t", "%.3f" % (te - ts)]
        args += ["-i", path, "-ar", str(REF_AUDIO_SR), "-ac", "2"]
    args += ["-f", "f32le", "-"]
    r = _run(args)
    arr = np.frombuffer(r.stdout, dtype=np.float32)
    if arr.size == 0:
        raise RuntimeError("音频解码结果为空: " + path)
    wav = torch.from_numpy(arr.reshape(-1, 2).T.copy()).unsqueeze(0)  # [1,2,L]
    if off > 0:
        pad = torch.zeros(1, 2, int(round(off * REF_AUDIO_SR)))
        wav = torch.cat([pad, wav], dim=-1)
    return {"waveform": wav, "sample_rate": REF_AUDIO_SR}


def _load_video_for_ref(path, ffmpeg, seg_cfg=None):
    """读参考视频（白模/成片参考）→ (IMAGE 帧 batch, AUDIO|None)。

    H3 原生 ref_videos 契约：IMAGE 帧序列 @24fps、2~15s（帧数由 H3 节点自己
    对齐 17k+5 网格并截断，这里只需不超 15s、不少于 5 帧）。
    解码走 imageio_ffmpeg read_frames 管道（避开 torchcodec/torchvision 视频 API
    在 Windows 的坑）；最长边预缩到 1280 控内存（H3 内部还会按画布再缩）。
    音轨复用 _load_audio_for_ref 的 PCM 管道（v2.2 起跟随段的裁剪/偏移设置，
    即视频界面 AUDIO 轨道上的拖拽调整对视频音轨同样生效）；
    无音轨（如白模渲染）返回 None。"""
    import imageio_ffmpeg
    # 加载帧率可调（v2.6）：默认 24=逐帧跟随；调低=抽帧概括动作（省显存、适合只取运镜）
    cfg = seg_cfg or {}
    vfps = max(1, min(24, int(cfg.get("video_fps") or 24)))
    vskip = max(0.0, float(cfg.get("video_skip") or 0))  # 起始秒（=教程的跳过前X帧，v2.6.1）
    gen = imageio_ffmpeg.read_frames(
        path, pix_fmt="rgb24",
        input_params=(["-ss", "%.3f" % vskip] if vskip > 0 else []),
        output_params=["-vf", "fps=%d,scale='if(gte(iw,ih),min(iw,1280),-2)':'if(gte(iw,ih),-2,min(ih,1280))'" % vfps])
    meta = next(gen)
    vw, vh = meta["size"]
    frames = []
    for buf in gen:
        frames.append(np.frombuffer(buf, np.uint8).reshape(vh, vw, 3))
        if len(frames) >= 24 * 15:  # H3 参考视频上限 15s（按 24fps 播放时长计，与采样帧率无关）
            break
    if len(frames) < 5:
        raise RuntimeError("参考视频不足 5 帧（H3 要求 ≥0.2s）: " + path)
    # v2.6.1：向上补齐到 H3 的 17k+5 帧网格（重复末帧）。低帧率采样（如教程的
    # 1fps 人物替换）只有 ~10 帧，H3 节点向下截断会砍到 5 帧丢一半信息；
    # 补齐保持全部关键帧。超 15s 上限时才向下截断。
    nf = len(frames)
    if nf % 17 != 5:
        up = nf + ((5 - nf) % 17)
        if up <= 24 * 15:
            frames.extend([frames[-1]] * (up - nf))
        else:
            frames = frames[:nf - ((nf - 5) % 17)]  # 向下取到 17k+5
    video = torch.from_numpy(np.stack(frames)).float() / 255.0  # [T,H,W,C]
    audio = None
    try:
        audio = _load_audio_for_ref(path, seg_cfg or {}, ffmpeg)
    except Exception:
        audio = None  # 无音轨（白模渲染常见），不算错误
    return video, audio


def _load_video_for_motion_context(path, ffmpeg, max_frames=56):
    """Decode an uploaded previous clip for Motion Context's pixel/audio path.

    Only the tail can be pinned by H3 Motion Context, so keep a rolling tail
    instead of materialising a full 15-second 4K clip in RAM.  Unlike the
    generic reference-video loader this must not pad frames: duplicated end
    frames would replace the actual motion at the seam.
    """
    import imageio_ffmpeg
    from collections import deque

    max_frames = max(1, min(56, int(max_frames or 56)))
    gen = imageio_ffmpeg.read_frames(
        path, pix_fmt="rgb24",
        output_params=["-vf", "fps=%d,scale='if(gte(iw,ih),min(iw,1280),-2)':'if(gte(iw,ih),-2,min(ih,1280))'" % FPS])
    meta = next(gen)
    vw, vh = meta["size"]
    tail = deque(maxlen=max_frames)
    try:
        for buf in gen:
            tail.append(np.frombuffer(buf, np.uint8).reshape(vh, vw, 3).copy())
    finally:
        try:
            gen.close()
        except Exception:
            pass
    if not tail:
        raise RuntimeError("上下文视频没有可读取的画面帧: " + path)
    frames = torch.from_numpy(np.stack(tuple(tail))).float() / 255.0
    try:
        audio = _load_audio_for_ref(path, {}, ffmpeg)
    except Exception as exc:
        raise RuntimeError("上下文视频没有可用音轨；请上传带音频的视频: " + path) from exc
    return frames, audio


def _load_input_image(name):
    img = Image.open(_resolve_input(name)).convert("RGB")
    arr = np.asarray(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


def _segment_guides(seg_cfg):
    """Read the director UI's per-segment Guide track defensively.

    A guide is deliberately data-only so old workflows stay valid.  Each
    record may carry an image, audio, or both; incomplete cards are ignored
    until the user finishes selecting their source files.
    """
    raw = (seg_cfg or {}).get("guides") or []
    if not isinstance(raw, list):
        return []
    out = []
    for order, guide in enumerate(raw):
        if not isinstance(guide, dict):
            continue
        image = str(guide.get("image") or "").strip()
        audio = str(guide.get("audio") or "").strip()
        if not image and not audio:
            continue
        try:
            at_seconds = float(guide.get("at_seconds", 0.0))
        except (TypeError, ValueError):
            at_seconds = 0.0
        out.append({
            "order": order,
            "image": image or None,
            "audio": audio or None,
            "at_seconds": max(0.0, at_seconds),
        })
    return out


def _guide_signature(seg_cfg):
    """Cache fingerprint for both Guide timing and the selected input files."""
    signature = []
    for guide in _segment_guides(seg_cfg):
        signature.append({
            "at_seconds": guide["at_seconds"],
            "image": _input_signature(guide["image"]),
            "audio": _input_signature(guide["audio"]),
        })
    return signature


def _apply_segment_guides(conditioning, latent, vae, audio_vae, seg_cfg,
                          trim_frames, total_frames, seg_idx, ffmpeg):
    """Chain this segment's Add Guide cards after Motion Context.

    Guide times are expressed in the *delivered* clip timeline.  Motion
    Context pins and later trims its head, therefore the anchor needs the
    matching trim offset while it is still operating on the sampler latent.
    This also keeps a 0-second guide out of Motion Context's protected head.
    """
    guides = _segment_guides(seg_cfg)
    if not guides:
        return conditioning

    visible_frames = max(1, int(total_frames) - max(0, int(trim_frames)))
    for guide in sorted(guides, key=lambda item: (item["at_seconds"], item["order"])):
        requested = int(round(guide["at_seconds"] * FPS))
        requested = max(0, min(visible_frames - 1, requested))
        frame_idx = requested + max(0, int(trim_frames))
        image = None
        audio = None
        if guide["image"]:
            try:
                image = _load_input_image(guide["image"])
            except Exception as exc:
                raise ValueError("[H3导演台] 段%d的图片锚点加载失败 %s: %s" % (
                    seg_idx, guide["image"], exc)) from exc
        if guide["audio"]:
            audio_path = _resolve_input(guide["audio"])
            if not os.path.isfile(audio_path):
                raise ValueError("[H3导演台] 段%d的音频锚点不存在: %s" % (
                    seg_idx, guide["audio"]))
            try:
                # Guide audio is an exact timeline anchor; do not inherit the
                # segment's dialogue trimming/offset settings.
                audio = _load_audio_for_ref(audio_path, {}, ffmpeg)
            except Exception as exc:
                raise ValueError("[H3导演台] 段%d的音频锚点加载失败 %s: %s" % (
                    seg_idx, guide["audio"], exc)) from exc
        result = MiniMaxH3AddGuide.execute(
            conditioning, latent, frame_idx,
            vae=vae if image is not None else None,
            audio_vae=audio_vae if audio is not None else None,
            image=image,
            audio=audio,
        )
        conditioning = result.result[0]
        _log("[H3导演台] 段%d Add Guide：第 %.2f 秒 -> 采样帧 %d%s%s" % (
            seg_idx, guide["at_seconds"], frame_idx,
            "（图片）" if image is not None else "",
            "（音频）" if audio is not None else ""))
    return conditioning


def _config_hash(cfg):
    s = json.dumps(cfg, ensure_ascii=False, sort_keys=True)
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def _run(cmd, **kw):
    # 始终二进制捕获（不开 text 模式）：
    # 1) text 模式 + input=bytes 会让 writer 线程炸 "must be str, not bytes"
    # 2) Windows 中文系统 text 模式默认 GBK 解码，ffmpeg 输出含 UTF-8 字节
    #    （如中文文件名"漫剧"）时 reader 线程炸 UnicodeDecodeError: 'gbk' codec
    # 需要文本时调用方自行 .decode("utf-8", "ignore")。
    r = subprocess.run(cmd, capture_output=True, **kw)
    if r.returncode != 0:
        err = (r.stderr or b"").decode("utf-8", "ignore")
        # 留 1500 字符：ffmpeg 真正的错误行常在输入/输出信息之后，500 会截掉关键原因
        raise RuntimeError("ffmpeg 失败: " + err[-1500:])
    return r


def _write_segment_video(frames_u8, audio, seg, ffmpeg,
                         custom_audio=None, audio_mode="replace", audio_vol=1.0,
                         audio_enabled=True,
                         audio_trim_start=0.0, audio_trim_end=0.0, audio_offset=0.0,
                         audio_trim_mode="keep", out_fps=24, mode="create",
                         amb_audio=None, amb_vol=0.25, project_id="default"):
    """frames_u8: [N,H,W,3] uint8；audio: dict(waveform[B,C,L], sample_rate)。写出 mp4 + 尾帧。
    custom_audio: 用户上传的本段音频绝对路径（配音/台词），可选。
    audio_mode: replace=自定义音频顶替 H3 原声；mix=与 H3 原声混合（原声自动压到 60%）。
    audio_trim_start/end: 自定义音频的裁剪区间（秒，end<=start 表示取到文件尾）。
    audio_offset: 自定义音频在段视频时间轴上的起始位置（秒），用 adelay 实现。
    输出音轨一律用 -t 对齐视频时长：自定义音频偏长会被截断，偏短则尾部静音，不会拖长视频。"""
    n, h, w, _ = frames_u8.shape
    dur = n / float(FPS)
    work_dir = _project_dir(project_id)
    os.makedirs(work_dir, exist_ok=True)
    fd, tmpv = tempfile.mkstemp(prefix="_h3_video_", suffix=".mp4", dir=work_dir)
    os.close(fd)
    fd, tmpout = tempfile.mkstemp(prefix="_h3_mux_", suffix=".mp4", dir=work_dir)
    os.close(fd)
    out = _seg_video(seg, mode, project_id)

    def _run_video_cmd(command, **kwargs):
        try:
            return _run(command, **kwargs)
        except Exception:
            for path in (tmpv, tmpout):
                try:
                    os.remove(path)
                except OSError:
                    pass
            raise

    out_fps = max(8, min(24, int(out_fps)))  # 输出帧率：低于原生 24 即抽帧，时长不变
    cmd = [ffmpeg, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", "%dx%d" % (w, h), "-r", str(FPS), "-i", "-",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18"]
    if out_fps != FPS:
        # 输出端 -r 在短片上会因时间基舍入额外丢掉数帧；fps filter 能保持原时长，
        # 只按目标帧率稳定抽帧。
        cmd += ["-vf", "fps=%d" % out_fps]
    cmd.append(tmpv)
    _run_video_cmd(cmd, input=frames_u8.tobytes())

    # 音频不落地 wav、不用 torchaudio（新版强制要求 torchcodec，Windows 难装），
    # 直接把波形以 f32le 交错格式从 stdin 喂给 ffmpeg，与视频一步合并。
    wav = audio["waveform"]
    if wav.dim() == 3:
        wav = wav[0]  # [B,C,L] -> [C,L]
    ch = wav.shape[0]
    sr = int(audio["sample_rate"])
    pcm = wav.cpu().float().clamp(-1, 1).t().contiguous()  # [C,L] -> [L,C] 逐帧交错
    audio_bytes = pcm.numpy().astype(np.float32).tobytes()

    # 自定义音频的输入侧裁剪参数（-ss/-t 放在 -i 之前，秒级精度足够配音场景）。
    # trim_mode=keep：保留 [ts,te]；=cut：删除 [ts,te] 保留首尾——
    # 删头/删尾可换算成 -ss/-t，中间挖洞则需 atrim+concat filter 链（mid_cut）。
    ca_in = []
    ts = max(0.0, float(audio_trim_start or 0))
    te = float(audio_trim_end or 0)
    mid_cut = False
    if custom_audio and os.path.exists(custom_audio):
        if audio_trim_mode == "cut" and (ts > 0 or te > 0):
            if ts > 0 and te > ts:
                mid_cut = True                     # 删除中段 [ts,te]，保留首尾
            elif te > 0:
                ca_in += ["-ss", "%.3f" % te]      # 删除 [0,te] = 保留 [te,尾]
            elif ts > 0:
                ca_in += ["-t", "%.3f" % ts]       # 删除 [ts,尾] = 保留 [0,ts]
        else:
            if ts > 0:
                ca_in += ["-ss", "%.3f" % ts]
            if te > ts and te > 0:
                ca_in += ["-t", "%.3f" % (te - ts)]
        ca_in += ["-i", custom_audio]
    delay_ms = max(0, int(round(float(audio_offset or 0) * 1000)))

    # 中间挖洞预处理链：src 标签拆两路取首尾，concat 接回后输出到 cac
    def _cut_pre(src):
        return ("[%s]asplit=2[cax][cay];[cax]atrim=0:%.3f[cap];"
                "[cay]atrim=start=%.3f[caq];[cap][caq]concat=n=2:v=0:a=1[cac];" % (src, ts, te))

    if not audio_enabled:
        # 音频总开关关闭：只写视频流、无音轨（本段静音）
        _run_video_cmd([ffmpeg, "-y", "-i", tmpv, "-c:v", "copy", "-an",
                        "-movflags", "+faststart", tmpout])
    elif custom_audio and os.path.exists(custom_audio):
        if audio_mode == "mix":
            # 两路先 aformat 统一采样率/声道再 amix——TTS 配音常见 22050Hz mono，
            # H3 原声是 32000Hz stereo，格式不一致 amix 直接报错（实测踩坑）。
            fc = ((_cut_pre("2:a") if mid_cut else "") +
                  "[1:a]aformat=sample_rates=%d:channel_layouts=stereo,volume=0.6[a1];"
                  "[%s]aformat=sample_rates=%d:channel_layouts=stereo,volume=%.2f,adelay=%d|%d[a2];"
                  "[a1][a2]amix=inputs=2:duration=longest:dropout_transition=0[aout]"
                  % (sr, "cac" if mid_cut else "2:a", sr, float(audio_vol), delay_ms, delay_ms))
            _run_video_cmd([ffmpeg, "-y", "-i", tmpv,
                            "-f", "f32le", "-ar", str(sr), "-ac", str(ch), "-i", "-"] + ca_in + [
                            "-filter_complex", fc,
                            "-map", "0:v", "-map", "[aout]",
                            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                            "-ar", str(sr), "-ac", "2",
                            "-movflags", "+faststart",
                            "-t", "%.3f" % dur, tmpout],
                           input=audio_bytes)
        else:
            # replace：自定义音频直接顶替 H3 原声。
            # 输出统一 -ar/-ac 2：否则本段 22050Hz mono、其他段 32000Hz stereo，
            # concat 无损合并时各段音轨参数不一致会出问题。
            fc = ((_cut_pre("1:a") if mid_cut else "") +
                  "[%s]aformat=sample_rates=%d:channel_layouts=stereo,adelay=%d|%d[aout]"
                  % ("cac" if mid_cut else "1:a", sr, delay_ms, delay_ms))
            _run_video_cmd([ffmpeg, "-y", "-i", tmpv] + ca_in + [
                            "-filter_complex", fc,
                            "-map", "0:v", "-map", "[aout]",
                            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                            "-ar", str(sr), "-ac", "2",
                            "-movflags", "+faststart",
                            "-t", "%.3f" % dur, tmpout])
    else:
        if amb_audio and os.path.exists(amb_audio):
            # 环境音垫层（v1.8+）：模型音轨不动，环境音文件 -stream_loop 循环铺满整段、
            # 低音量垫在底下。H3 参考音频条件会压制模型自生成环境音（实测提示词无效），
            # 这是确定性的兜底方案。amix normalize=0 保持人声 1:1，alimiter 防叠加削波。
            fc = ("[1:a]aformat=sample_rates=%d:channel_layouts=stereo[a1];"
                  "[2:a]aformat=sample_rates=%d:channel_layouts=stereo,volume=%.2f[a2];"
                  "[a1][a2]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amx];"
                  "[amx]alimiter=limit=0.95[aout]"
                  % (sr, sr, float(amb_vol)))
            _run_video_cmd([ffmpeg, "-y", "-i", tmpv,
                            "-f", "f32le", "-ar", str(sr), "-ac", str(ch), "-i", "-",
                            "-stream_loop", "-1", "-i", amb_audio,
                            "-filter_complex", fc,
                            "-map", "0:v", "-map", "[aout]",
                            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                            "-ar", str(sr), "-ac", "2",
                            "-movflags", "+faststart", "-t", "%.3f" % dur, tmpout],
                           input=audio_bytes)
        else:
            _run_video_cmd([ffmpeg, "-y", "-i", tmpv,
                            "-f", "f32le", "-ar", str(sr), "-ac", str(ch), "-i", "-",
                            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                            "-ar", str(sr), "-ac", "2",
                            "-movflags", "+faststart", "-shortest", tmpout],
                           input=audio_bytes)

    try:
        os.remove(tmpv)
    except OSError:
        pass

    os.replace(tmpout, out)
    Image.fromarray(frames_u8[-1]).save(_seg_tail(seg, mode, project_id))
    return out


def _fit_frame(frame, target_size):
    if not target_size:
        return frame
    tw, th = target_size
    h, w = frame.shape[:2]
    if (w, h) == (tw, th):
        return frame
    scale = min(tw / float(w), th / float(h))
    rw, rh = max(1, round(w * scale)), max(1, round(h * scale))
    import cv2
    resized = cv2.resize(frame, (rw, rh), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
    canvas = np.zeros((th, tw, 3), dtype=np.uint8)
    x, y = (tw - rw) // 2, (th - rh) // 2
    canvas[y:y + rh, x:x + rw] = resized
    return canvas


def _read_segment_video(seg, mode="create", project_id="default", target_size=None, target_fps=FPS):
    """从 mp4 还原 frames float tensor + audio dict（用于缓存段的输出重建）。"""
    import cv2
    import imageio_ffmpeg
    import wave as wave_mod
    import io
    path = _seg_video(seg, mode, project_id)
    cap = cv2.VideoCapture(path)
    source_fps = float(cap.get(cv2.CAP_PROP_FPS) or target_fps)
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(_fit_frame(cv2.cvtColor(f, cv2.COLOR_BGR2RGB), target_size))
    cap.release()
    if not frames:
        raise RuntimeError("[H3导演台] 无法读取缓存段视频: " + path)
    source_count = len(frames)
    arr = np.stack(frames)
    if target_fps is not None and abs(source_fps - target_fps) > 0.01:
        target_count = max(1, round(source_count * target_fps / source_fps))
        indices = np.minimum((np.arange(target_count) * source_fps / target_fps).astype(np.int64), source_count - 1)
        arr = arr[indices]
    arr = arr.astype(np.float32) / 255.0

    # 读音频同样绕开 torchaudio：ffmpeg 把音轨转成 16bit PCM wav 输出到 stdout，
    # 用标准库 wave 解析（采样率/声道数自动从 wav 头读，无需任何第三方依赖）。
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    # 先探测有无音轨：音频开关关闭的段（-an 生成）没有音轨，直接跑 -vn 提音频会
    # 报 "Output file does not contain any stream"。此时造等长静音保持输出结构一致。
    probe = subprocess.run([ffmpeg, "-hide_banner", "-i", path],
                           capture_output=True)
    if "Audio:" in (probe.stderr or b"").decode("utf-8", "ignore"):
        r = _run([ffmpeg, "-y", "-i", path, "-vn", "-acodec", "pcm_s16le", "-f", "wav", "-"])
        with wave_mod.open(io.BytesIO(r.stdout)) as wf:
            sr = wf.getframerate()
            ch = wf.getnchannels()
            raw = wf.readframes(wf.getnframes())
        a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        a = a.reshape(-1, ch).T.copy()  # 逐帧交错 [L*C] -> [C,L]
    else:
        sr, ch = 32000, 2
        n_silent = max(1, int(round(source_count / source_fps * sr)))
        a = np.zeros((ch, n_silent), dtype=np.float32)
    return torch.from_numpy(arr), {"waveform": torch.from_numpy(a)[None,], "sample_rate": sr,
                                   "fps": max(1, round(source_fps))}


def _read_segment_preview(seg, mode="create", project_id="default", target_size=None):
    import cv2
    path = _seg_video(seg, mode, project_id)
    cap = cv2.VideoCapture(path)
    source_fps = float(cap.get(cv2.CAP_PROP_FPS) or FPS)
    source_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    cap.release()
    tail = _seg_tail(seg, mode, project_id)
    if not os.path.exists(tail):
        raise RuntimeError("[H3导演台] 找不到段%d尾帧: %s" % (seg, tail))
    frame = np.asarray(Image.open(tail).convert("RGB"))
    frame = _fit_frame(frame, target_size)
    total_frames = max(1, round(source_count * FPS / source_fps))
    return torch.from_numpy(frame.astype(np.float32) / 255.0)[None,], total_frames


class H3DirectorStudio:
    """漫剧导演台·一体节点。segments_json 由节点内时间轴 UI 维护：
    [{"prompt": str, "seed": int, "refs": [input图片文件名...], "duration": float(秒，可省),
      "inherit_shared": bool, "use_tail": bool, "enabled": bool, "force": bool}, ...]
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "audio_vae": ("VAE",),
                "width": ("INT", {"default": 832, "min": 32, "max": 4096, "step": 32}),
                "height": ("INT", {"default": 480, "min": 32, "max": 4096, "step": 32}),
                "时长秒": ("FLOAT", {"default": 10.0, "min": 1.0, "max": 15.0, "step": 0.5}),
                "steps": ("INT", {"default": 25, "min": 1, "max": 200, "step": 1}),
                "sampler": (comfy.samplers.SAMPLER_NAMES,),
                "scheduler": (comfy.samplers.SCHEDULER_NAMES,),
                "ref_image_size": (["match", "max"],),
                "segments_json": ("STRING", {"default": "[]", "multiline": True}),
                "vsegments_json": ("STRING", {"default": "[]", "multiline": True}),
                "tsegments_json": ("STRING", {"default": "[]", "multiline": True}),
                "ui_mode": ("STRING", {"default": "create"}),
                "global_prompt": ("STRING", {"default": "", "multiline": True}),
                # 兼容旧工作流的隐藏字段：续接方式根据可用模型自动决定；
                # “每段后卸载模型”由前端显示为“8GB稳定”，不新增 widget 以免旧工作流错位。
                "续接方式": (["硬首帧FL2VA(不跳帧)", "软参考Ref2VA(保人物)"],),
                "每段后卸载模型": ("BOOLEAN", {"default": False}),
                # Motion Context 全局设置区：目录字段按“目录”解释，保存时自动
                # 追加 clip 前缀，得到 clip_00001.safetensors 等固定槽位。
                "上下文保存目录": ("STRING", {
                    "default": "h3_context",
                    "tooltip": "每段 H3 AV latent 的保存目录。相对路径位于 ComfyUI/output；"
                               "绝对路径可指向其他本地目录。内部按 clip_00001.safetensors 命名。"}),
                "上下文加载目录": ("STRING", {
                    "default": "h3_context",
                    "tooltip": "MotionContext 启用时，从这里加载上一段固定槽位。"
                               "生成第2段时加载 clip_00001.safetensors。"}),
                "MotionContext画面帧数": (["22", "5", "39", "56"], {
                    "default": "22",
                    "tooltip": "从上一段尾部固定到新段开头的画面帧数；22 为官方推荐。"}),
                "MotionContext音频帧数": ("INT", {
                    "default": 24, "min": 0, "max": 240, "step": 1,
                    "tooltip": "上一段尾部音频上下文长度；24 帧等于 1 秒，0 跟随画面长度。"}),
                "MotionContext匹配尾部": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "裁剪 Motion Context 前缀后，让音频长度精确匹配画面。"}),
                # 末尾空字符串只用于兼容从 2.13.x 升级、尚未被前端迁移的旧工作流。
                # 默认仍是第一项；前端加载后会立即把空值改成“仅预览帧”。
                "汇总输出": (["仅预览帧(推荐)", "单段视频输出", "完整帧和音频(高内存)", ""],
                             {"default": "仅预览帧(推荐)"}),
                "project_id": ("STRING", {"default": ""}),
                "text_shared_refs_json": ("STRING", {"default": "[]", "multiline": True}),
                # 追加在所有旧 widget 之后，避免已有工作流的 widgets_values 错位。
                "output_dir": ("STRING", {
                    "default": "output",
                    "multiline": False,
                    "tooltip": "每段最终 MP4 的额外导出目录。默认 output 表示 ComfyUI 自带输出目录；"
                               "修改目录不会重跑模型，"
                               "会从导演台缓存补导出。"}),
                "filename_prefix": ("STRING", {
                    "default": "ComfyUI",
                    "multiline": False,
                    "tooltip": "文件名规则：前缀_当前片段数（4位）_当前段视频短边（宽高较小值）_年月日_时_分.mp4；同名时自动追加序号。"}),
                "外部文本目标段": ("INT", {
                    "default": 1, "min": 1, "max": 9999, "step": 1,
                    "tooltip": "由导演台界面自动同步当前选中段，用于把外部文本送入正确的段。"}),
            },
            "optional": {
                "fl2va_model": ("MODEL",),
                "外部SIGMAS": ("SIGMAS", {
                    "tooltip": "可选的最终采样调度。连接方式：基本调度器 → 任意第三方 "
                               "SIGMAS 处理节点 → 本接口。连接后覆盖导演台内部 steps/scheduler；"
                               "不连接时继续使用内部基本调度。请使用与导演台采样模型一致的模型生成。"}),
                "外部文本": ("STRING", {
                    "forceInput": True,
                    "tooltip": "连接任意 STRING 文本节点。运行时覆盖当前选中段右侧文本框的提示词；"
                               "断开后恢复使用文本框原内容。"}),
                "阿里云OSS配置": ("ALIYUN_OSS_CONFIG", {
                    "tooltip": "选择‘latent 延续：阿里云’时，连接‘阿里云 OSS 配置（REST）’节点。"}),
            },
            "hidden": {
                "h3_prompt_graph": "PROMPT",
                "h3_unique_id": "UNIQUE_ID",
            },
        }

    # 新输出追加在末尾，保持旧工作流的插槽编号不变。
    RETURN_TYPES = ("IMAGE", "AUDIO", "INT", "INT", "STRING", "INT", "LATENT", "CONDITIONING", "NOISE")
    RETURN_NAMES = ("images", "audio", "fps", "frame_count", "report", "segment_number", "latent", "positive", "noise")
    FUNCTION = "direct"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True
    DESCRIPTION = "一体式长序列分镜融合台。段间文件接力，配置未变的段自动跳过。"

    # ---------------- 单段生成 ----------------
    def _run_segment(self, seg_idx, seg_cfg, shared_refs, model, fl2va_model, clip, vae, audio_vae,
                      width, height, default_dur, steps, sampler_name, scheduler, ref_image_size, mode="create",
                      global_prompt="", tail_mode="ref2v", unload_per_seg=False, project_id="default",
                      primary_model_kind="unknown", context_save_dir="h3_context",
                      context_load_dir="h3_context", context_length="22",
                      audio_context_length=24, context_match_tail=True,
                      external_sigmas=None, save_context_latent=True,
                      return_internal_outputs=False, oss_config=None):
        # 0) 计算本段时长与帧数（缺失时用节点默认时长），帧数对齐 ≡5 (mod 17)
        # 段级分辨率覆盖（v2.8）：每段视频尺寸可不同；留空=跟随节点宽高
        _wo = int(seg_cfg.get("width") or 0)
        _ho = int(seg_cfg.get("height") or 0)
        if _wo >= 256 and _ho >= 256:
            width, height = _wo, _ho
        dur = seg_cfg.get("duration", default_dur)
        try:
            dur = float(dur)
        except (TypeError, ValueError):
            dur = default_dur
        dur = max(1.0, min(15.0, dur))
        length = max(5, round(dur * FPS))
        length += (5 - (length % 17)) % 17
        _log("[H3导演台] 段%d 时长 %.1f 秒 -> %d 帧" % (seg_idx, dur, length))

        # 1) 组装画面条件。所有生成方式都可选择“续接上段尾帧”或
        # Motion Context；两者互斥。端点模式启用尾帧时，尾帧作为首帧输入，
        # 因而会覆盖该模式原本的首帧图，但仍保留该模式指定的尾帧图。
        generation_mode = _generation_mode(seg_cfg)
        endpoint_mode = generation_mode != "multi_ref"
        endpoint_names = [name for name in (seg_cfg.get("refs") or []) if name]
        endpoint_first = None
        endpoint_last = None
        ref_images = {}
        included = []
        pic_no = 1

        def _push(img):
            nonlocal pic_no
            for old in included:
                if _is_same_image(old, img):
                    _log("[H3导演台] 跳过重复参考图（内容相同）")
                    return False
            ref_images["ref_image_%d" % (pic_no - 1)] = img
            included.append(img)
            pic_no += 1
            return True

        if not endpoint_mode and seg_cfg.get("inherit_shared", True):
            for img in shared_refs:
                if img is not None:
                    _push(img)
        tail_note = ""
        # v2.13.16：续接方式——硬首帧FL2VA 时上段尾帧作 first_frame 喂 ImageToVideo（像素级续接不跳帧），
        # 不进 ref_images（该段人物参考图/参考音频随之失效，人物靠尾帧传递）；软参考 Ref2VA 为原行为。
        first_frame_tensor = None
        tail_is_fl2v = ((endpoint_mode or tail_mode == "fl2v")
                         and seg_cfg.get("use_tail", False) and seg_idx > 1)
        if seg_cfg.get("use_tail", False) and seg_idx > 1:
            tp = _seg_tail(seg_idx - 1, mode, project_id)
            if os.path.exists(tp):
                img = Image.open(tp).convert("RGB")
                arr = np.asarray(img).astype(np.float32) / 255.0
                if tail_is_fl2v:
                    first_frame_tensor = torch.from_numpy(arr)[None,]
                    tail_note = " + 段%d尾帧(FL2VA首帧)" % (seg_idx - 1)
                elif _push(torch.from_numpy(arr)[None,]):
                    tail_note = " + 段%d尾帧" % (seg_idx - 1)
            else:
                _log("[H3导演台] 警告：段%d 的尾帧不存在，段%d 将无续接参考" % (seg_idx - 1, seg_idx))
                tail_is_fl2v = False
        if endpoint_mode:
            def _load_endpoint(index, label):
                if len(endpoint_names) <= index:
                    raise ValueError(
                        "[H3导演台] 段%d选择了%s，但参考图区缺少%s。"
                        % (seg_idx, {"first_frame": "首帧生视频", "first_last_frame": "首尾帧生视频",
                                     "last_frame": "尾帧生视频"}.get(generation_mode, "该模式"), label))
                try:
                    return _load_input_image(endpoint_names[index])
                except Exception as e:
                    raise ValueError("[H3导演台] 段%d的%s加载失败：%s" % (seg_idx, label, e)) from e

            if generation_mode == "first_frame":
                endpoint_first = _load_endpoint(0, "第1张首帧图")
            elif generation_mode == "first_last_frame":
                endpoint_first = _load_endpoint(0, "第1张首帧图")
                endpoint_last = _load_endpoint(1, "第2张尾帧图")
            elif generation_mode == "last_frame":
                # 两张及以上时严格按“左首右尾”取第二张；只上传一张时它就是尾帧。
                endpoint_last = _load_endpoint(1 if len(endpoint_names) >= 2 else 0,
                                               "第2张尾帧图（仅一张图时使用第1张）")
            if first_frame_tensor is not None:
                endpoint_first = first_frame_tensor
                tail_note = " + 段%d尾帧(作为本段首帧)" % (seg_idx - 1)
            _log("[H3导演台] 段%d 生成模式：%s（首帧=%s，尾帧=%s）" % (
                seg_idx, generation_mode, bool(endpoint_first is not None), bool(endpoint_last is not None)))
        else:
            for name in endpoint_names:
                try:
                    _push(_load_input_image(name))
                except Exception as e:
                    _log("[H3导演台] 参考图加载失败 %s: %s" % (name, e))

        _log("[H3导演台] ==== 段%d 开始生成（模式 %s，参考图 %d 张%s）====" % (
            seg_idx, generation_mode, len(ref_images), tail_note))

        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()

        # 本段自定义音频解析（三种用法见下：ref 驱动 / replace 替换 / mix 混合）
        custom_audio = None
        aname = seg_cfg.get("audio")
        if aname:
            candidate = _resolve_input(aname)
            if os.path.exists(candidate):
                custom_audio = candidate
            else:
                _log("[H3导演台] 警告：段%d 的音频文件不存在 %s，将使用 H3 原声" % (seg_idx, aname))

        # 参考音频（H3 最多 3 路独立 ref_audios）。两类来源按序占编号：
        #   1) 本段音频的「参考音频驱动」模式（复刻/复刻+环境音/仅音色）
        #   2) 参考音色槽 voice_refs（多角色音色，如唐僧音色给人物1 说新台词）
        # 关键（MiniMax 官方 R2V 提示词指南）：模型是否"用"参考音频取决于提示词里
        # 声明的保留关系——fully_copy=1:1 复用整轨；partially_copy=复用对话层+
        # 模型补环境音；reference=只学音色。不声明模型会忽略参考音频（实测踩坑）。
        ref_audios = {}
        audio_decls = []  # 每路一路："copy" | "partial" | "timbre" | "voice"
        if not endpoint_mode and seg_cfg.get("audio_src") == "ref" and custom_audio:
            try:
                ref_audios["ref_audio_%d" % len(ref_audios)] = _load_audio_for_ref(custom_audio, seg_cfg, ffmpeg)
                custom_audio = None  # 音轨由模型生成/复用，事后不再替换
                if seg_cfg.get("audio_ref_mode", "copy") == "timbre":
                    audio_decls.append("timbre")
                elif seg_cfg.get("audio_ref_ambient"):
                    audio_decls.append("partial")
                else:
                    audio_decls.append("copy")
                _log("[H3导演台] 段%d 使用参考音频驱动（%s，占 <Audio 1>）" % (seg_idx, audio_decls[-1]))
            except Exception as e:
                _log("[H3导演台] 参考音频加载失败，回退 H3 原声: %s" % e)

        voice_modes = seg_cfg.get("voice_modes") or {}
        for vn in ([] if endpoint_mode else [n for n in (seg_cfg.get("voice_refs") or []) if n]):
            if len(ref_audios) >= 3:
                _log("[H3导演台] 参考音频已达 3 路上限，音色 %s 被忽略" % vn)
                break
            vp = _resolve_input(vn)
            if not os.path.exists(vp):
                _log("[H3导演台] 警告：参考音色文件不存在 %s" % vn)
                continue
            try:
                ref_audios["ref_audio_%d" % len(ref_audios)] = _load_audio_for_ref(vp, {}, ffmpeg)
                # dub=对口型配音（该角色照这段音频说台词）；voice=只学音色（v1.10 槽级切换）
                audio_decls.append("dub" if voice_modes.get(vn) == "copy" else "voice")
            except Exception as e:
                _log("[H3导演台] 参考音色加载失败 %s: %s" % (vn, e))
        if audio_decls:
            _log("[H3导演台] 段%d 参考音频共 %d 路: %s" % (seg_idx, len(ref_audios), ",".join(audio_decls)))
        if not ref_audios:
            ref_audios = None
        if endpoint_mode and (seg_cfg.get("audio_src") == "ref" or seg_cfg.get("voice_refs")):
            _log("[H3导演台] 段%d 的首/尾帧模式不使用参考音频或参考音色" % seg_idx)

        # ---- 参考视频（v2.0 视频界面）：白模→成片 / 照片人物替换视频人物 ----
        # H3 原生 ref_videos：帧序列进 VAE + Qwen 按 2fps 带时间戳"看"视频，
        # 提示词里用 <Video N> 引用；ref_video_audio_N 按索引与 ref_video_N 配对。
        ref_videos = {}
        ref_video_audios = {}
        video_names = [] if endpoint_mode else [n for n in (seg_cfg.get("video_refs") or []) if n]
        if len(video_names) > 3:
            raise ValueError("[H3导演台] 段%d最多只能上传 3 个参考视频。" % seg_idx)
        video_audio_refs = seg_cfg.get("video_audio_refs") or {}
        if not isinstance(video_audio_refs, dict):
            video_audio_refs = {}
        for vn in video_names:
            vp = _resolve_input(vn)
            if not os.path.exists(vp):
                _log("[H3导演台] 警告：参考视频不存在 %s" % vn)
                continue
            try:
                vframes, vaudio = _load_video_for_ref(vp, ffmpeg, seg_cfg)
                idx = len(ref_videos)
                ref_videos["ref_video_%d" % idx] = vframes
                if vaudio is not None and bool(video_audio_refs.get(vn)):
                    ref_video_audios["ref_video_audio_%d" % idx] = vaudio
                _log("[H3导演台] 段%d 参考视频 <Video %d>: %s（%d 帧%s）" % (
                    seg_idx, idx + 1, vn, vframes.shape[0],
                    "，已接视频声音参考" if vaudio is not None and bool(video_audio_refs.get(vn)) else ""))
            except Exception as e:
                _log("[H3导演台] 参考视频加载失败 %s: %s" % (vn, e))
        if not ref_videos:
            ref_videos = None
            ref_video_audios = None
        if endpoint_mode and seg_cfg.get("video_refs"):
            _log("[H3导演台] 段%d 的首/尾帧模式不使用参考视频" % seg_idx)

        seg_prompt = seg_cfg.get("prompt", "")
        if global_prompt and global_prompt.strip():
            seg_prompt = global_prompt.strip().rstrip() + "\n\n" + seg_prompt
        prompt = _convert_at_refs(seg_prompt)
        orig_prompt = prompt  # 声明跳过判定必须看用户原文，不能被自动追加的声明干扰
        if ref_audios:
            # 按官方 R2V 结构为每路音频生成声明。
            # 跳过条件（v1.14.1 修正）：只有提示词里真的写了【保留声明】才跳过——
            # 模板/AI 生成的提示词只含 <Audio 1> 绑定句（is the dialogue of...）却没有
            # retention_analysis，若仅按标签跳过会丢掉 fully_copy 声明，模型就自由发挥
            # 不复用音频（实测：模板生成的段音轨与配音相关性≈0，本 bug 的根因）。
            user_declared = ("retention_analysis" in prompt) or ("fully_copy" in prompt)
            defs, rets, dets = [], [], []
            for k, kind in enumerate(audio_decls, 1):
                tag = "<Audio %d>" % k
                if user_declared and kind != "voice":
                    continue
                if kind == "copy":
                    defs.append("%s is the dialogue source and voice reference for the main speaker (S%d)." % (tag, k))
                    rets.append("%s: fully_copy - %s is reused 1:1 as the target video's complete final audio track." % (tag, tag))
                    dets.append("The main speaker (S%d) performs exactly the lines from %s, lip movements precisely synchronized with %s." % (k, tag, tag))
                elif kind == "partial":
                    defs.append("%s is the dialogue source and voice reference for the main speaker (S%d)." % (tag, k))
                    rets.append("%s: partially_copy - the dialogue layer of %s is reused 1:1 as the target's dialogue track; ambient sounds, sound effects and music are newly generated around it." % (tag, tag))
                    dets.append("The main speaker (S%d) performs exactly the lines from %s with lip movements precisely synchronized, while ambient sounds and effects are generated naturally." % (k, tag))
                elif kind == "timbre":
                    defs.append("%s is the voice-timbre reference for the main speaker (S%d)." % (tag, k))
                    rets.append("%s: reference - the target speaker follows %s's voice timbre and delivery without copying the original signal." % (tag, tag))
                    dets.append("The main speaker (S%d) speaks the lines described above using the voice timbre referenced from %s." % (k, tag))
                elif kind == "dub":
                    # 对口型配音槽（v1.10+）：该说话人照 <Audio k> 说台词、口型同步（partially_copy）。
                    # 双人对话：两个 dub 槽各占一路，(S1)/(S2) 各自绑定各自的配音。
                    defs.append("%s is the dialogue source for speaker (S%d)." % (tag, k))
                    rets.append("%s: partially_copy - the dialogue lines of %s are reused 1:1 as speaker (S%d)'s lines in the target video." % (tag, tag, k))
                    dets.append("Speaker (S%d) performs exactly the lines from %s, lip movements precisely synchronized with %s." % (k, tag, tag))
                else:  # voice 音色槽：只声明音色归属，台词由提示词指定
                    defs.append("%s is the voice-timbre reference for speaker (S%d)." % (tag, k))
                    rets.append("%s: reference - speaker (S%d)'s voice follows %s's timbre and delivery without copying the original signal." % (tag, k, tag))
            if defs:
                header = ("[reference generation + audio reuse]" if any(d in ("copy", "partial", "dub") for d in audio_decls)
                          else "[reference generation + audio reference]")
                prompt = prompt.rstrip() + (
                    "\n\n" + header +
                    "\nsubject_definitions: " + " ".join(defs) +
                    "\nretention_analysis: " + " ".join(rets) +
                    ("\ndetailed_description: " + " ".join(dets) if dets else ""))
            # v1.10：overall_soundscape 自动追加已移除——实测参考音频条件下模型不生成
            # 环境音，该行无效；「H3 环境音」勾选 UI 同步下架。
        # 参考视频声明（v2.0）：官方 reference 关系——动作/运镜/节奏跟 <Video N>，
        # 外观（人物长相/画风/场景）来自参考图和提示词。
        # 跳过条件（v2.5.1 修正，与音频 v1.14.1 同款）：只有用户原文里同时出现
        # retention_analysis 和 <Video 标签（=真的手写了视频保留声明）才跳过；
        # 只写 <Video 1> 引用句不算——否则自动声明被吞，模型不跟视频（实测踩坑）。
        _user_decl_video = ("retention_analysis" in orig_prompt) and ("<Video" in orig_prompt)
        if ref_videos and not _user_decl_video:
            vtags = ["<Video %d>" % (k + 1) for k in range(len(ref_videos))]
            # v2.5.7：结构对齐机智罗_LX 教程的多模态参考写法——素材关系（镜头轨迹/
            # 主体动作/节奏 1:1 复刻 + 主体 100% 强制替换）+ 限制（一镜到底无转场），
            # 保留官方 retention_analysis 词汇。
            prompt = prompt.rstrip() + (
                "\n\n[reference generation + video reference]"
                "\nsubject_definitions: " + " ".join(
                    "%s is the source video." % t for t in vtags)
                + " The reference images supply the subjects' visual appearance (look, style, scene)."
                "\nretention_analysis: " + " ".join(
                    "%s: reference - the camera trajectory, subject motion, blocking and rhythm of %s"
                    " are recreated 1:1; every subject in %s is completely replaced by the subjects"
                    " from the reference images." % (t, t, t)
                    for t in vtags)
                + "\ndetailed_description: One continuous smooth take following the camera path and"
                " pacing of " + " and ".join(vtags)
                + "; all appearances come from the reference images and the prompt."
                " No cuts, no flicker, no transitions of any kind.")
        if endpoint_mode:
            # 端点模式只使用主 model 输入，不要求也不读取可选 fl2va_model。
            # 这样主模型已接 FL2VA 的工作流不必额外接一根重复模型线；若主模型
            # 不是 FL2VA，明确阻止它以错误模型进入 ImageToVideo。
            if primary_model_kind != "fl2va":
                actual = {
                    "ref2va": "Ref2VA",
                    "not_connected": "未连接模型",
                    "unknown": "无法识别的模型",
                }.get(primary_model_kind, "非 FL2VA 模型")
                raise ValueError(
                    "[H3导演台] 段%d选择了%s，但主 model 当前是%s。"
                    "请在主 model 输入接入 FL2VA 模型；此模式不检查 fl2va_model 输入。"
                    % (seg_idx, {"text_to_video": "文生视频", "first_frame": "首帧生视频",
                                 "first_last_frame": "首尾帧生视频", "last_frame": "尾帧生视频"}[generation_mode], actual))
            task = "fl2va"
        else:
            task = _select_h3_task(
                primary_model_kind=primary_model_kind,
                has_optional_fl2va=fl2va_model is not None,
                has_references=bool(ref_images or ref_audios or ref_videos),
                has_first_frame=first_frame_tensor is not None,
                prefer_fl2va=tail_mode == "fl2v")
        if task == "fl2va":
            # 端点模式固定使用主 model；旧版多参续接仍兼容可选 fl2va_model。
            out = MiniMaxH3ImageToVideo.execute(
                clip, vae, prompt, width, height, length,
                first_frame=endpoint_first if endpoint_mode else first_frame_tensor,
                last_frame=endpoint_last if endpoint_mode else None)
            sample_model = model if endpoint_mode else (fl2va_model if fl2va_model is not None else model)
        else:
            out = MiniMaxH3ReferenceToVideo.execute(
                clip, vae, audio_vae, prompt, width, height, length,
                ref_image_size=ref_image_size, ref_images=ref_images, ref_audios=ref_audios,
                ref_videos=ref_videos, ref_video_audios=ref_video_audios)
            sample_model = model
        # v2.13.5：容错解包——新版 ComfyUI 内核的 H3 节点 result 可能返回 3+ 个值，
        # 按索引取前两个，避免 "too many values to unpack (expected 2)"。
        _res = out.result
        cond, latent = _res[0], _res[1]
        del out, _res, ref_images, ref_audios, ref_videos, ref_video_audios, included, first_frame_tensor

        # Motion Context 可从任意段开始。本地 index=0 只建立新链并保存
        # clip_00001，不读取旧 latent；index>0 才加载对应固定槽位。
        motion_enabled = seg_cfg.get("motion_context", False) is True
        motion_source = _motion_context_source(seg_cfg)
        motion_local_index = _motion_context_local_index(seg_cfg, seg_idx - 1)
        trim_frames = 0
        MotionClass = TrimClass = SaveClass = LoadClass = None
        if motion_enabled:
            MotionClass, TrimClass, SaveClass, LoadClass = _motion_context_classes()
            if motion_source == "video":
                video_name = str(seg_cfg.get("motion_context_video") or "").strip()
                if not video_name:
                    raise ValueError("[H3导演台] 段%d选择了 MotionContext 视频延续，但尚未上传上下文视频。" % seg_idx)
                video_path = _resolve_input(video_name)
                if not os.path.isfile(video_path):
                    raise ValueError("[H3导演台] 段%d的上下文视频不存在: %s" % (seg_idx, video_name))
                context_frames, context_audio = _load_video_for_motion_context(
                    video_path, ffmpeg, max_frames=int(context_length))
                cond, trim_frames = _motion_context_apply(
                    MotionClass, cond, vae, latent, context_length,
                    audio_context_length=int(audio_context_length),
                    context_frames=context_frames, audio_vae=audio_vae,
                    context_audio=context_audio,
                )
                del context_frames, context_audio
                _log("[H3导演台] 段%d MotionContext 视频延续：%s（画面 %s 帧，音频 %d 帧；未加载 latent）" % (
                    seg_idx, os.path.basename(video_path), context_length, int(audio_context_length)))
            else:
                if motion_source == "upload_latent":
                    latent_name = str(seg_cfg.get("motion_context_latent") or "").strip()
                    if not latent_name:
                        raise ValueError("[H3导演台] 段%d选择了上传 latent 延续，但尚未上传 H3 Motion Context latent。" % seg_idx)
                    latent_path = _resolve_input(latent_name)
                    if not os.path.isfile(latent_path):
                        raise ValueError("[H3导演台] 段%d的上传 latent 不存在: %s" % (seg_idx, latent_name))
                    previous_latent = LoadClass().load(latent_path, clip_index=0)[0]
                    source_note = "上传 latent " + os.path.basename(latent_path)
                elif motion_source == "aliyun_oss" and motion_local_index > 0:
                    previous_latent, object_key = _oss_load_h3_latent(oss_config, motion_local_index)
                    source_note = "阿里云 " + object_key
                elif motion_local_index > 0:
                    previous_latent = LoadClass().load(context_load_dir, clip_index=motion_local_index)[0]
                    source_note = "本地 clip %d" % motion_local_index
                else:
                    previous_latent = None
                    source_note = "阿里云 index 0（不加载 latent）" if motion_source == "aliyun_oss" else "本地 index 0（不加载 latent）"
                if previous_latent is None:
                    _log("[H3导演台] 段%d MotionContext 已选择：%s" % (
                        seg_idx, source_note))
                else:
                    cond, trim_frames = _motion_context_apply(
                        MotionClass, cond, vae, latent, context_length,
                        audio_context_length=int(audio_context_length),
                        context_latent=previous_latent,
                    )
                    del previous_latent
                    _log("[H3导演台] 段%d MotionContext 已启用：%s，画面 %s 帧，音频 %d 帧" % (
                        seg_idx, source_note, context_length, int(audio_context_length)))
        else:
            _log("[H3导演台] 段%d MotionContext 已关闭：不加载上一段 clip" % seg_idx)

        # 段级 Guide 在 Motion Context 之后追加。这样多个 Guide 的 positive
        # 会像画布上连续串联的 Add Guide 一样逐个累积，并且其秒数以最终导出
        # （已去掉上下文前缀）的片段为准。
        cond = _apply_segment_guides(
            cond, latent, vae, audio_vae, seg_cfg,
            trim_frames=trim_frames, total_frames=length,
            seg_idx=seg_idx, ffmpeg=ffmpeg)

        if external_sigmas is None:
            sigmas = comfy.samplers.calculate_sigmas(
                sample_model.get_model_object("model_sampling"), scheduler, steps).cpu()[-(steps + 1):]
        else:
            if not isinstance(external_sigmas, torch.Tensor):
                raise TypeError("[H3导演台] 外部SIGMAS 必须连接标准 SIGMAS 输出")
            if external_sigmas.ndim != 1 or external_sigmas.numel() < 2:
                raise ValueError("[H3导演台] 外部SIGMAS 必须是一维序列且至少包含两个值")
            if not torch.isfinite(external_sigmas).all():
                raise ValueError("[H3导演台] 外部SIGMAS 包含 NaN 或无穷值")
            sigmas = external_sigmas.detach().cpu()
            _log("[H3导演台] 段%d 使用外部 SIGMAS：%d 个采样区间，内部 steps/scheduler 已绕过" % (
                seg_idx, sigmas.numel() - 1))
        sampler = comfy.samplers.sampler_object(sampler_name)
        guider = Guider_Basic(sample_model)
        guider.set_conds(cond)
        noise = Noise_RandomNoise(int(seg_cfg.get("seed", 0)))

        x0_output = {}
        callback = latent_preview.prepare_callback(guider.model_patcher, sigmas.shape[-1] - 1, x0_output)
        latent_image = latent["samples"]
        latent_image = comfy.sample.fix_empty_latent_channels(
            guider.model_patcher, latent_image,
            latent.get("downscale_ratio_spacial", None), latent.get("downscale_ratio_temporal", None))
        samples = guider.sample(
            noise.generate_noise(latent), latent_image, sampler, sigmas,
            callback=callback, disable_pbar=not comfy.utils.PROGRESS_BAR_ENABLED, seed=noise.seed)
        samples = samples.to(comfy.model_management.intermediate_device())
        output_latent = {"samples": samples} if return_internal_outputs else None
        output_positive = cond if return_internal_outputs else None
        output_noise = noise if return_internal_outputs else None

        # 无论 MotionContext 段级开关是否开启，每个已生成段都保存 H3 AV latent。
        # clip_index 使用真实段号；重跑同一段只覆盖自己的主存储固定槽位。
        # 是否保存由“下一段”是否选择本地 latent 自动续接决定。这样云平台在
        # 视频延续链路中连首段也不会尝试写 nested latent。
        if save_context_latent:
            save_index = _motion_context_local_index(seg_cfg, seg_idx - 1) + 1
            if motion_source == "aliyun_oss":
                saved_context_path, _ = _oss_save_h3_latent(samples, oss_config, save_index)
            else:
                if SaveClass is None:
                    MotionClass, TrimClass, SaveClass, LoadClass = _motion_context_classes()
                saved_context_path = SaveClass().save(
                    {"samples": samples}, _context_save_prefix(context_save_dir),
                    clip_index=save_index)[0]
            _log("[H3导演台] 段%d 上下文 clip %d 已保存：%s" % (
                seg_idx, save_index, saved_context_path))
        else:
            _log("[H3导演台] 段%d 后续不需要本地 latent：跳过 Motion Context latent 保存" % seg_idx)

        with torch.inference_mode():
            # H3 的 AV latent 是嵌套张量（视频+音频打包），视频解码前需解包取 [0]
            video_lat = samples
            if getattr(video_lat, "is_nested", False):
                video_lat = video_lat.unbind()[0]
            frames = vae.decode(video_lat)
            audio = vae_decode_audio(audio_vae, {"samples": samples})
        frames = frames.float().clamp(0, 1).cpu()
        if frames.dim() == 5:
            frames = frames[0]  # vae.decode 返回 [B,T,H,W,C]，取 batch 0 -> [T,H,W,C]
        audio = {
            "waveform": audio["waveform"].detach().float().cpu(),
            "sample_rate": int(audio["sample_rate"]),
        }
        if motion_enabled and trim_frames > 0:
            frames, audio = _motion_context_trim(
                TrimClass, frames, trim_frames, audio=audio, fps=float(FPS),
                match_tail=bool(context_match_tail))
            _log("[H3导演台] 段%d MotionContext 已裁掉开头 %d 帧，并同步处理音频" % (
                seg_idx, trim_frames))
        audio_samples = int(audio["waveform"].shape[-1])

        # 采样和 VAE 解码已经结束：先释放 GPU 相关对象，再做 numpy 转换和 FFmpeg 编码。
        # 这样不会让近 20GB 的模型搬运状态与整段 RGB 帧在内存里长时间重叠。
        del samples, video_lat, latent_image, cond, latent, guider, callback, x0_output, noise, sigmas, sampler
        gc.collect()
        comfy.model_management.soft_empty_cache()
        comfy.model_management.cleanup_models()
        if unload_per_seg:
            # “8GB稳定”模式：本段模型工作结束后立即深度卸载；下一段会按需重新加载。
            comfy.model_management.unload_all_models()
            gc.collect()
            comfy.model_management.soft_empty_cache()

        frames_u8 = (frames.numpy() * 255).round().astype(np.uint8)
        del frames

        os.makedirs(_project_dir(project_id), exist_ok=True)
        # 环境音垫层：从音频库选一条环境音（风声/白噪/BGM）垫在成片音轨下
        amb_audio = None
        amb_name = seg_cfg.get("amb_audio")
        if amb_name:
            amb_p = _resolve_input(amb_name)
            if os.path.exists(amb_p):
                amb_audio = amb_p
            else:
                _log("[H3导演台] 警告：段%d 的环境音文件不存在 %s" % (seg_idx, amb_name))
        out_path = _write_segment_video(frames_u8, audio, seg_idx, ffmpeg,
                                        custom_audio=custom_audio,
                                        audio_mode=seg_cfg.get("audio_mode", "replace"),
                                        audio_vol=seg_cfg.get("audio_vol", 1.0),
                                        audio_enabled=seg_cfg.get("audio_enabled", True),
                                        audio_trim_start=seg_cfg.get("audio_trim_start", 0.0),
                                        audio_trim_end=seg_cfg.get("audio_trim_end", 0.0),
                                        audio_offset=seg_cfg.get("audio_offset", 0.0),
                                        audio_trim_mode=seg_cfg.get("audio_trim_mode", "keep"),
                                        out_fps=seg_cfg.get("fps", 24), mode=mode,
                                        amb_audio=amb_audio,
                                        amb_vol=seg_cfg.get("amb_vol", 0.25),
                                        project_id=project_id)

        del frames_u8, audio
        gc.collect()
        return out_path, audio_samples, output_latent, output_positive, output_noise

    # ---------------- 主流程 ----------------
    def direct(self, model, clip, vae, audio_vae, width, height, 时长秒, steps,
               sampler, scheduler, ref_image_size, segments_json,
               vsegments_json="[]", tsegments_json="[]", ui_mode="create",
               global_prompt="", 续接方式="硬首帧FL2VA(不跳帧)", 每段后卸载模型=False,
               上下文保存目录="h3_context", 上下文加载目录="h3_context",
               MotionContext画面帧数="22", MotionContext音频帧数=24,
               MotionContext匹配尾部=True,
               汇总输出="仅预览帧(推荐)", project_id="", text_shared_refs_json="[]",
               output_dir="output", filename_prefix="ComfyUI",
               外部文本目标段=1,
               fl2va_model=None, 外部SIGMAS=None, 外部文本=None, 阿里云OSS配置=None,
               h3_prompt_graph=None, h3_unique_id=None):
        # v2.3: two independent workspaces; ui_mode selects the dataset,
        # outputs use per-mode file names so the two never overwrite each other.
        # v2.11: 文本界面（text）——纯提示词生成，无参考图/视频/音频，数据与产出同样独立。
        mode = ui_mode if ui_mode in ("video", "text") else "create"
        try:
            _src = {"video": vsegments_json, "text": tsegments_json}.get(mode, segments_json)
            segments = json.loads(_src or "[]")
        except Exception:
            raise ValueError("[H3导演台] segments_json 解析失败，请在节点时间轴界面里重新编辑分段")
        if not segments:
            raise ValueError("[H3导演台] 没有任何分段，请在节点时间轴界面里添加分段")

        oss_config = None
        if any(_motion_context_source(segment) == "aliyun_oss" for segment in segments):
            oss_config = _oss_config(阿里云OSS配置)

        # 标准 STRING 扩展口：只覆盖界面当前选中的一段，其他段仍使用各自文本框。
        # 只修改本次解析出的配置副本，不回写/破坏右侧文本框的备用内容。
        external_text_target = max(1, min(len(segments), int(外部文本目标段 or 1)))
        if 外部文本 is not None:
            segments[external_text_target - 1]["prompt"] = str(外部文本)

        # 所有界面和生成方式都允许两种续接方式。它们只彼此互斥，
        # 且均可关闭；不再因段号或生成方式被后台强制改写。
        for _idx, _sc in enumerate(segments):
            if _sc.get("motion_context") is True:
                _sc["motion_context"] = True
                _sc["use_tail"] = False
                if _motion_context_source(_sc) in ("local_latent", "aliyun_oss"):
                    _sc["motion_context_index"] = _motion_context_local_index(_sc, _idx)
            else:
                _sc["motion_context"] = False
                _sc["use_tail"] = bool(_sc.get("use_tail", False))

        # 每段独立计算分辨率。尾帧和 latent 都不能跨尺寸续接；旧工作流或
        # 手改 JSON 即使绕过前端，也必须在采样前阻止。
        _segment_sizes = []
        for _idx, _sc in enumerate(segments):
            if _idx > 0 and _sc.get("motion_context") is True:
                _previous = segments[_idx - 1]
                if str(_previous.get("aspect_ratio") or "") in SEGMENT_ASPECT_RATIOS:
                    for _key in ("aspect_ratio", "megapixels", "multiple"):
                        _sc[_key] = _previous.get(_key)
                else:
                    for _key in ("aspect_ratio", "megapixels", "multiple"):
                        _sc.pop(_key, None)
                _sc["width"], _sc["height"] = _segment_sizes[_idx - 1]
                try:
                    _sc["fps"] = max(8, min(24, round(float(_previous.get("fps", 24)))))
                except (TypeError, ValueError):
                    _sc["fps"] = 24
            _sw, _sh = _segment_resolution(_sc, width, height)
            _sc["width"], _sc["height"] = _sw, _sh
            _segment_sizes.append((_sw, _sh))
        for _idx in range(1, len(segments)):
            _sc = segments[_idx]
            _prev_aspect = str(segments[_idx - 1].get("aspect_ratio") or "")
            _this_aspect = str(_sc.get("aspect_ratio") or "")
            _aspect_changed = (_prev_aspect in SEGMENT_ASPECT_RATIOS
                               and _this_aspect in SEGMENT_ASPECT_RATIOS
                               and _prev_aspect != _this_aspect)
            if (_sc.get("use_tail") is True or _sc.get("motion_context") is True) \
                    and (_aspect_changed or _segment_sizes[_idx] != _segment_sizes[_idx - 1]):
                _kind = "续接上段尾帧" if _sc.get("use_tail") is True else "MotionContext"
                raise ValueError(
                    "[H3导演台] 段%d为 %dx%d，上段为 %dx%d；分辨率或比例不同，不能启用%s。"
                    "请关闭这两个续接选项，或把两段设置成相同的比例、百万像素和倍数。" % (
                        _idx + 1, _segment_sizes[_idx][0], _segment_sizes[_idx][1],
                        _segment_sizes[_idx - 1][0], _segment_sizes[_idx - 1][1], _kind))

        # v2.18.2：兼容旧工作流新增 widget 被保存为空的情况。目录值与原生
        # Motion Context 对齐：导演台把保存目录 h3_context 自动转换为
        # Save Latent 的 h3_context/clip 前缀；加载目录直接使用 h3_context。
        上下文保存目录 = str(上下文保存目录 or "").strip() or "h3_context"
        上下文加载目录 = str(上下文加载目录 or "").strip() or "h3_context"
        MotionContext画面帧数 = str(MotionContext画面帧数 or "22")
        if MotionContext画面帧数 not in ("22", "5", "39", "56"):
            MotionContext画面帧数 = "22"
        try:
            MotionContext音频帧数 = int(MotionContext音频帧数)
        except (TypeError, ValueError):
            MotionContext音频帧数 = 24
        if not 0 <= MotionContext音频帧数 <= 240:
            MotionContext音频帧数 = 24

        output_dir = str(output_dir or "").strip().strip('"').strip("'") or "output"
        # v2.21.1：迁移 2.20.x 曾误写入节点的项目专用默认值。
        if os.path.normcase(os.path.normpath(output_dir)) == os.path.normcase(os.path.normpath(
                r"E:\短剧项目\骗子\片段\第二场")):
            output_dir = "output"
        filename_prefix = str(filename_prefix or "").strip() or "ComfyUI"
        if filename_prefix == "骗子_736":
            filename_prefix = "ComfyUI"
        filename_prefix = _safe_export_prefix(filename_prefix)

        # 外部链路在进入任何耗时的视频编码/采样前先完成校验，错误可立即反馈。
        if 外部SIGMAS is not None:
            if not isinstance(外部SIGMAS, torch.Tensor):
                raise TypeError("[H3导演台] 外部SIGMAS 必须连接标准 SIGMAS 输出")
            if 外部SIGMAS.ndim != 1 or 外部SIGMAS.numel() < 2:
                raise ValueError("[H3导演台] 外部SIGMAS 必须是一维序列且至少包含两个值")
            if not bool(torch.isfinite(外部SIGMAS).all().item()):
                raise ValueError("[H3导演台] 外部SIGMAS 包含 NaN 或无穷值")

        low_vram_mode = bool(每段后卸载模型)
        requested_steps = int(steps)
        if low_vram_mode and 外部SIGMAS is None:
            steps = min(requested_steps, 20)
        forced_preview = low_vram_mode and str(汇总输出).startswith("完整")
        if forced_preview:
            汇总输出 = "仅预览帧(推荐)"
        # v2.7：视频界面恢复分段（时间轴回归：每段=照片+对应参考视频，可分段运行），
        # 时长回到段级配置（时间轴拖块/段行输入），节点「时长秒」仅作新建段默认值。
        # v2.18.1：三个界面统一使用“尾帧 / MotionContext”二选一，不再让视频界面
        # 私自清除续接模式。
        # 文本界面不再提供共享多参考图 UI；旧工作流保存的隐藏参考图数据仍兼容读取。
        # 视频/配音/音色字段始终清空，段间续接尾帧仍由段上开关控制。
        if mode == "text":
            for _sc in segments:
                _sc["video_refs"] = []
                _sc["voice_refs"] = []
                _sc["audio"] = None

        project_id = _safe_project_id(project_id or ("node_" + str(h3_unique_id or "default")))
        os.makedirs(_project_dir(project_id), exist_ok=True)
        need_internal_outputs = any(
            _output_connected(h3_prompt_graph, h3_unique_id, output_index)
            for output_index in (6, 7, 8))
        output_latent = None
        output_positive = None
        output_noise = None

        shared_refs = []
        shared_ref_names = []
        if mode == "text":
            try:
                shared_ref_names = json.loads(text_shared_refs_json or "[]")
                if not isinstance(shared_ref_names, list):
                    raise TypeError
            except (TypeError, ValueError, json.JSONDecodeError):
                raise ValueError("[H3导演台] 旧工作流共享参考图数据损坏，请新建导演台节点")
            for name in shared_ref_names:
                try:
                    shared_refs.append(_load_input_image(name))
                except Exception as e:
                    raise ValueError("[H3导演台] 旧工作流共享参考图加载失败 %s: %s" % (name, e)) from e

        primary_model_kind = _upstream_model_kind(h3_prompt_graph, h3_unique_id, "model")
        # 可选 FL2VA 或主口识别到 FL2VA 时，允许单模型 FL2VA/t2va 与硬首帧续接。
        tail_mode = "fl2v" if (fl2va_model is not None or primary_model_kind == "fl2va") else "ref2v"
        ref_model_sig = _upstream_fingerprint(h3_prompt_graph, h3_unique_id, "model")
        fl_model_sig = _upstream_fingerprint(h3_prompt_graph, h3_unique_id, "fl2va_model")
        external_sigmas_sig = _sigmas_signature(外部SIGMAS)
        report = ["H3 导演台运行报告", "段数 %d | %sx%s | 默认 %.1f 秒/段（每段可用 duration 覆盖）| %d steps %s/%s"
                  % (len(segments), width, height, 时长秒, steps, sampler, scheduler)]
        report.append("项目 %s | 自动续接 %s" % (
            project_id, "FL2VA硬首帧" if tail_mode == "fl2v" else "Ref2VA软参考"))
        model_note = {
            "fl2va": "主模型已识别为 FL2VA（支持单模型模式）",
            "ref2va": "主模型已识别为 Ref2VA",
            "unknown": "主模型类型未识别，按 Ref2VA 兼容模式",
            "not_connected": "主模型上游未连接",
        }.get(primary_model_kind, "主模型类型未知")
        report.append(model_note + (" | 已连接可选 FL2VA" if fl2va_model is not None else ""))
        if 外部SIGMAS is None:
            report.append("采样调度：导演台内部基本调度器（%d steps，%s）" % (steps, scheduler))
        else:
            report.append("采样调度：外部 SIGMAS（%d 个采样区间），内部 steps/scheduler 已绕过" % (
                int(外部SIGMAS.numel()) - 1))
        report.append("MotionContext | 保存目录 %s | 加载目录 %s | 画面 %s 帧 | 音频 %d 帧" % (
            上下文保存目录 or "h3_context", 上下文加载目录 or "h3_context",
            MotionContext画面帧数, int(MotionContext音频帧数)))
        report.append("成片导出 | 目录 %s | 命名 %s_片段号(4位)_视频短边_年月日_时_分.mp4" % (
            _resolve_export_directory(output_dir), filename_prefix))
        if 外部文本 is not None:
            report.append("外部文本：已连接并覆盖段%d提示词" % external_text_target)
        if low_vram_mode:
            report.append("8GB稳定模式：仅返回预览帧、每段模型工作结束后深度卸载；建议单段约 5.2 秒（124 帧）")
            if requested_steps != steps:
                report.append("8GB稳定模式已把采样步数从 %d 限制为 %d" % (requested_steps, steps))
            if forced_preview:
                report.append("8GB稳定模式已把高内存汇总输出强制改为仅预览帧")

        done = []      # seg_idx 已就绪
        ran = []       # 本次新生成
        for k, seg_cfg in enumerate(segments):
            seg_idx = k + 1
            if comfy.model_management.processing_interrupted():
                raise comfy.model_management.InterruptProcessingException()
            if not seg_cfg.get("enabled", True):
                report.append("段%d: 跳过（未启用）" % seg_idx)
                continue

            motion_source = _motion_context_source(seg_cfg)
            motion_local_index = _motion_context_local_index(seg_cfg, k)
            # 选择本地或阿里云 latent 延续的当前段负责保存 index+1。这样 index=0
            # 可作为新链起点：不加载旧文件，生成后写出 clip_00001。
            save_context_latent = bool(
                seg_cfg.get("motion_context", False) is True
                and motion_source in ("local_latent", "aliyun_oss")
            )
            save_context_index = motion_local_index + 1

            run_cfg = {
                "cache_schema": CACHE_SCHEMA,
                "prompt": (global_prompt or "") + "\n\n" + seg_cfg.get("prompt", ""), "seed": seg_cfg.get("seed", 0),
                "generation_mode": _generation_mode(seg_cfg),
                "refs": [_input_signature(n) for n in (seg_cfg.get("refs") or [])],
                "guides": _guide_signature(seg_cfg),
                "shared_refs": [_input_signature(n) for n in shared_ref_names],
                "duration": seg_cfg.get("duration", 时长秒),
                "inherit_shared": seg_cfg.get("inherit_shared", True),
                "use_tail": bool(seg_cfg.get("use_tail", False)),
                "motion_context": seg_cfg.get("motion_context", False) is True,
                "motion_context_source": motion_source,
                "motion_context_index": motion_local_index,
                "motion_context_latent": _input_signature(seg_cfg.get("motion_context_latent")),
                "motion_context_video": _input_signature(seg_cfg.get("motion_context_video")),
                "oss_target": (_oss_object_key(oss_config, save_context_index) if motion_source == "aliyun_oss" else None),
                "save_context_latent": save_context_latent,
                "save_context_index": save_context_index if save_context_latent else None,
                "tail_mode": tail_mode,
                "tail": (_path_signature(_seg_tail(seg_idx - 1, mode, project_id))
                         if seg_cfg.get("use_tail", False) and seg_idx > 1 else None),
                "audio": _input_signature(seg_cfg.get("audio")),
                "audio_src": seg_cfg.get("audio_src", ""),
                "audio_ref_mode": seg_cfg.get("audio_ref_mode", "copy"),
                "audio_ref_ambient": bool(seg_cfg.get("audio_ref_ambient")),
                "voice_refs": [_input_signature(n) for n in (seg_cfg.get("voice_refs") or [])],
                "video_refs": [_input_signature(n) for n in (seg_cfg.get("video_refs") or [])],
                "video_audio_refs": {
                    str(n): bool((seg_cfg.get("video_audio_refs") or {}).get(n))
                    for n in (seg_cfg.get("video_refs") or []) if n
                },
                "video_fps": seg_cfg.get("video_fps") or 24,
                "video_skip": seg_cfg.get("video_skip") or 0,
                "width": seg_cfg.get("width") or 0,
                "height": seg_cfg.get("height") or 0,
                "voice_modes": seg_cfg.get("voice_modes") or {},
                "amb_audio": _input_signature(seg_cfg.get("amb_audio")),
                "amb_vol": seg_cfg.get("amb_vol", 0.25),
                "audio_mode": seg_cfg.get("audio_mode", "replace"),
                "audio_vol": seg_cfg.get("audio_vol", 1.0),
                "audio_enabled": seg_cfg.get("audio_enabled", True),
                "audio_trim_start": seg_cfg.get("audio_trim_start", 0.0),
                "audio_trim_end": seg_cfg.get("audio_trim_end", 0.0),
                "audio_offset": seg_cfg.get("audio_offset", 0.0),
                "audio_trim_mode": seg_cfg.get("audio_trim_mode", "keep"),
                "fps": seg_cfg.get("fps", 24),
                "w": width, "h": height,
                "steps": steps if 外部SIGMAS is None else None,
                "sampler": sampler,
                "scheduler": scheduler if 外部SIGMAS is None else None,
                "external_sigmas": external_sigmas_sig,
                "ris": ref_image_size,
                "ref_model": ref_model_sig,
                "fl2va_model": fl_model_sig,
                "context_save_dir": str(上下文保存目录 or "h3_context"),
                "context_load_dir": str(上下文加载目录 or "h3_context"),
                "context_length": str(MotionContext画面帧数),
                "audio_context_length": int(MotionContext音频帧数),
                "context_match_tail": bool(MotionContext匹配尾部),
                "context_source": (
                    _input_signature(seg_cfg.get("motion_context_video")) if motion_source == "video"
                    else _input_signature(seg_cfg.get("motion_context_latent")) if motion_source == "upload_latent"
                    else {"key": _oss_object_key(oss_config, motion_local_index), "etag": _oss_object_etag(oss_config, motion_local_index)}
                    if motion_source == "aliyun_oss" and motion_local_index > 0
                    else (_path_signature(_context_slot_path(上下文加载目录, motion_local_index))
                          if motion_local_index > 0 and seg_cfg.get("motion_context", False) is True
                          and _context_slot_path(上下文加载目录, motion_local_index) else None)
                ),
            }
            h = _config_hash(run_cfg)
            meta_ok = False
            meta_data = {}
            video_path = _seg_video(seg_idx, mode, project_id)
            meta_path = _seg_meta(seg_idx, mode, project_id)
            if os.path.exists(video_path) and os.path.exists(meta_path):
                try:
                    with open(meta_path, encoding="utf-8") as f:
                        meta_data = json.load(f)
                    meta_ok = meta_data.get("hash") == h
                except (OSError, ValueError, json.JSONDecodeError):
                    meta_data = {}
                    meta_ok = False

            # 本地 latent 模式要保证当前指定的 index+1 主槽位已经写出。
            context_slot = _context_slot_path(上下文保存目录, save_context_index)
            if motion_source == "aliyun_oss" and save_context_latent:
                try:
                    context_slot = _oss_object_etag(oss_config, save_context_index)
                except RuntimeError:
                    context_slot = None
            if save_context_latent and context_slot is None:
                meta_ok = False

            generated_now = False
            return_internal_outputs = need_internal_outputs and seg_idx == external_text_target
            if meta_ok and not seg_cfg.get("force") and not return_internal_outputs:
                report.append("段%d: 缓存命中%s，跳过生成" % (
                    seg_idx, "（clip %d 已存在）" % save_context_index if save_context_latent else ""))
            else:
                video_path, _, segment_latent, segment_positive, segment_noise = self._run_segment(
                    seg_idx, seg_cfg, shared_refs, model, fl2va_model, clip, vae, audio_vae,
                    width, height, 时长秒, steps, sampler, scheduler, ref_image_size, mode,
                    global_prompt,
                    tail_mode=tail_mode, unload_per_seg=low_vram_mode,
                    project_id=project_id, primary_model_kind=primary_model_kind,
                    context_save_dir=上下文保存目录,
                    context_load_dir=上下文加载目录,
                    context_length=MotionContext画面帧数,
                    audio_context_length=MotionContext音频帧数,
                    context_match_tail=MotionContext匹配尾部,
                    external_sigmas=外部SIGMAS,
                    save_context_latent=save_context_latent,
                    return_internal_outputs=return_internal_outputs,
                    oss_config=oss_config)
                if return_internal_outputs:
                    output_latent = segment_latent
                    output_positive = segment_positive
                    output_noise = segment_noise
                generated_now = True
                meta_data = {
                    "schema": CACHE_SCHEMA,
                    "hash": h,
                    "prompt": seg_cfg.get("prompt", ""),
                }
                ran.append(seg_idx)
                mc_note = ({"local_latent": "本地 latent（index %d）" % motion_local_index,
                            "aliyun_oss": "阿里云 latent（index %d）" % motion_local_index,
                            "upload_latent": "上传 latent", "video": "视频延续"}.get(motion_source)
                    if seg_cfg.get("motion_context", False) is True else "关闭")
                save_note = "已保存 clip %d" % save_context_index if save_context_latent else "不保存 latent"
                report.append("段%d: 已生成 -> %s | MotionContext %s | %s" % (
                    seg_idx, os.path.basename(video_path), mc_note, save_note))
            if os.path.exists(video_path):
                try:
                    exported_path, export_sig, copied = _export_segment_video(
                        video_path, output_dir, filename_prefix, seg_idx,
                        min(_segment_sizes[k][0], _segment_sizes[k][1]),
                        previous_meta=meta_data, force=generated_now)
                except Exception as e:
                    raise RuntimeError("[H3导演台] 段%d成片导出失败：%s" % (seg_idx, e)) from e
                if export_sig:
                    meta_data["export_signature"] = export_sig
                    meta_data["export_path"] = exported_path
                    if copied:
                        report.append("段%d: 已导出 -> %s" % (seg_idx, exported_path))
                # 新生成段和补导出都会刷新元数据；只改目录/前缀不会触发模型重跑。
                if generated_now or export_sig:
                    with open(meta_path, "w", encoding="utf-8") as f:
                        json.dump(meta_data, f, ensure_ascii=False)
                done.append(seg_idx)

        # （按用户要求已移除自动合并：每段独立成片，不再生成 漫剧_60s_合并.mp4）

        if need_internal_outputs and output_latent is None:
            raise ValueError("[H3导演台] 当前选中段%d未生成，无法输出 latent 和 positive。请选中已启用的段后运行。" % external_text_target)

        if str(汇总输出).startswith("完整"):
            all_frames = []
            all_wavs = []
            for i in done:
                fr, au = _read_segment_video(i, mode, project_id, target_size=(width, height), target_fps=FPS)
                all_frames.append(fr)
                all_wavs.append((au["waveform"], int(au["sample_rate"])))
            images = torch.cat(all_frames, dim=0) if all_frames else torch.zeros((1, height, width, 3))
            if all_wavs:
                sr = all_wavs[0][1]
                ch = max(w.shape[-2] for w, _ in all_wavs)
                norm = []
                for w, source_sr in all_wavs:
                    if source_sr != sr:
                        length = max(1, round(w.shape[-1] * sr / source_sr))
                        w = torch.nn.functional.interpolate(w, size=length, mode="linear", align_corners=False)
                    if w.shape[-2] == 1 and ch > 1:
                        w = w.repeat(1, ch, 1)
                    elif w.shape[-2] < ch:
                        pad = torch.zeros((w.shape[0], ch - w.shape[-2], w.shape[-1]), dtype=w.dtype, device=w.device)
                        w = torch.cat([w, pad], dim=-2)
                    norm.append(w)
                waveform = torch.cat(norm, dim=-1)
            else:
                sr = 32000
                waveform = torch.zeros((1, 2, 1))
            frame_count = images.shape[0]
        elif 汇总输出 == "单段视频输出":
            if external_text_target not in done:
                raise ValueError("[H3导演台] 当前选中段%d未生成，无法输出单段视频。请选中已启用的段后运行。" % external_text_target)
            images, segment_audio = _read_segment_video(
                external_text_target, mode, project_id, target_fps=None)
            waveform = segment_audio["waveform"]
            sr = int(segment_audio["sample_rate"])
            frame_count = images.shape[0]
            fps = int(segment_audio["fps"])
            report.append("汇总输出为单段视频：段%d的完整画面与音频已按原分辨率、原帧率输出" % external_text_target)
        else:
            images = torch.zeros((1, height, width, 3))
            frame_count = 0
            for i in done:
                images, count = _read_segment_preview(i, mode, project_id, target_size=(width, height))
                frame_count += count
            sr = 32000
            waveform = torch.zeros((1, 2, 1))
            report.append("汇总输出为省内存预览：IMAGE 仅返回最后一段尾帧，AUDIO 返回静音占位；各段 MP4 保留完整音画")
        audio = {"waveform": waveform, "sample_rate": sr}
        report.append("本次新生成段: %s" % (",".join(map(str, ran)) if ran else "无（全部缓存）"))
        report.append("当前选中段编号: %d" % external_text_target)
        _log("[H3导演台] 完成。新生成 %s，合并段 %s" % (ran, done))
        return (images, audio, fps if 汇总输出 == "单段视频输出" else FPS,
                frame_count, "\n".join(report), int(external_text_target),
                output_latent, output_positive, output_noise)


NODE_CLASS_MAPPINGS = {"H3DirectorStudio": H3DirectorStudio}
NODE_DISPLAY_NAME_MAPPINGS = {"H3DirectorStudio": "H3 长序列分镜融合台"}
