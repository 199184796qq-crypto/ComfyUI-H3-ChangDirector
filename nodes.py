# -*- coding: utf-8 -*-
"""H3 漫剧导演台 - 自定义节点
- H3DirectorTailFrame：从文件读取上一段尾帧（段间解耦的关键）
- H3DirectorMerge：ffmpeg 合并各段 mp4 为完整成片
"""
import os
import glob
import re
import subprocess
import tempfile

import numpy as np
import torch
from PIL import Image

import folder_paths

CATEGORY = "H3导演台"
OUTPUT_DIR = folder_paths.get_output_directory()
VIDEO_DIR = os.path.join(OUTPUT_DIR, "video")
PROJECT_ROOT = os.path.join(VIDEO_DIR, "h3director")


def _log(msg):
    try:
        print(msg)
    except Exception:
        pass


def _latest(pattern):
    files = glob.glob(pattern)
    if not files:
        return None
    return max(files, key=os.path.getmtime)


def _safe_project_id(value):
    value = re.sub(r"[^0-9A-Za-z_-]+", "_", str(value or "").strip())[:80].strip("_")
    return value


def _project_dir(project_id):
    project_id = _safe_project_id(project_id)
    return os.path.join(PROJECT_ROOT, project_id) if project_id else None


def _all_output_dirs():
    roots = [VIDEO_DIR]
    try:
        roots.extend(p for p in glob.glob(os.path.join(PROJECT_ROOT, "*")) if os.path.isdir(p))
    except OSError:
        pass
    return roots


def _tail_path(seg, project_id=""):
    exact = _project_dir(project_id)
    roots = [exact] if exact else _all_output_dirs()
    files = []
    for root in roots:
        files.extend(glob.glob(os.path.join(root, "tail_seg%d_*.png" % seg)))
    return max(files, key=os.path.getmtime) if files else None


def _merge_source_dir(project_id=""):
    exact = _project_dir(project_id)
    if exact:
        return exact
    candidates = []
    for root in _all_output_dirs():
        first = _latest(os.path.join(root, "漫剧_seg1_*.mp4"))
        if first:
            candidates.append((os.path.getmtime(first), root))
    return max(candidates)[1] if candidates else VIDEO_DIR


def _video_path(seg, project_id="", source_dir=None):
    root = source_dir or _project_dir(project_id) or _merge_source_dir("")
    return _latest(os.path.join(root, "漫剧_seg%d_*.mp4" % seg))


def _safe_output_stem(value):
    raw = str(value or "").strip()
    drive, _ = os.path.splitdrive(raw)
    if not raw or drive or os.path.isabs(raw) or ".." in raw or "/" in raw or "\\" in raw:
        raise ValueError("[H3导演台] 输出文件名只能是文件名，不能包含路径、盘符或 '..'")
    if raw.lower().endswith(".mp4"):
        raw = raw[:-4]
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", raw).strip(" ._")[:120]
    if not stem:
        raise ValueError("[H3导演台] 输出文件名为空或不合法")
    if re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])", stem):
        raise ValueError("[H3导演台] 输出文件名是 Windows 保留设备名，请换一个名称")
    return stem


def _concat_quote(path):
    # ffmpeg concat demuxer 使用单引号包裹路径；路径内单引号需按其转义语法拆开。
    return path.replace("\\", "/").replace("'", "'\\''")


class H3DirectorTailFrame:
    """读取上一段保存的尾帧 PNG，作为本段的 <Picture 4> 参考图。
    可选输入"排序依赖"仅用于整图运行时保证先后顺序，不参与计算。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "上一段编号": ("INT", {"default": 1, "min": 1, "max": 999, "step": 1}),
                "project_id": ("STRING", {"default": ""}),
            },
            "optional": {
                "排序依赖": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("上一段尾帧",)
    FUNCTION = "load"
    CATEGORY = CATEGORY
    DESCRIPTION = "从指定导演台项目读取尾帧；project_id 留空时兼容旧目录并选择最新文件。"

    def load(self, 上一段编号, project_id="", 排序依赖=None):
        path = _tail_path(上一段编号, project_id)
        if not path:
            raise FileNotFoundError(
                "[H3导演台] 找不到第%d段的尾帧文件（project_id=%s）。"
                "请先在导演台面板运行第%d段，或使用面板的「从视频续接」上传一段视频。"
                % (上一段编号, project_id or "自动", 上一段编号)
            )
        img = Image.open(path).convert("RGB")
        arr = np.asarray(img).astype(np.float32) / 255.0
        _log("[H3导演台] 段%d 尾帧 <- %s" % (上一段编号 + 1, os.path.basename(path)))
        return (torch.from_numpy(arr)[None,],)

    @classmethod
    def IS_CHANGED(cls, 上一段编号, project_id="", 排序依赖=None):
        path = _tail_path(上一段编号, project_id)
        if not path:
            return "missing"
        return "%s|%d" % (path, os.path.getmtime_ns(path))


class H3DirectorMerge:
    """把 output/video/漫剧_seg1..N 的最新 mp4 按顺序合并成一个成片。
    可选输入 seg_1..seg_6 仅用于整图运行时排在各段之后执行，不参与计算。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "段数": ("INT", {"default": 6, "min": 2, "max": 999, "step": 1}),
                "输出文件名": ("STRING", {"default": "漫剧_60s_合并"}),
                "project_id": ("STRING", {"default": ""}),
            },
            "optional": {
                "seg_1": ("VIDEO",), "seg_2": ("VIDEO",), "seg_3": ("VIDEO",),
                "seg_4": ("VIDEO",), "seg_5": ("VIDEO",), "seg_6": ("VIDEO",),
            },
        }

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "merge"
    CATEGORY = CATEGORY
    DESCRIPTION = "用 ffmpeg 拼接指定导演台项目的创作界面分段；project_id 留空时自动选择最近项目。"

    def merge(self, 段数, 输出文件名, project_id="", **kwargs):
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        output_stem = _safe_output_stem(输出文件名)
        source_dir = _merge_source_dir(project_id)

        vids = []
        missing = []
        for i in range(1, 段数 + 1):
            p = _video_path(i, project_id, source_dir=source_dir)
            if p:
                vids.append(p)
            else:
                missing.append(i)
        if missing:
            _log("[H3导演台] 缺少段 %s 的视频，本次不合并。" % ",".join(map(str, missing)))
            return ()

        os.makedirs(source_dir, exist_ok=True)
        list_fd, listfile = tempfile.mkstemp(prefix="_h3_merge_", suffix=".txt", dir=source_dir)
        os.close(list_fd)
        tmp_fd, tmp = tempfile.mkstemp(prefix="_h3_merge_", suffix=".mp4", dir=source_dir)
        os.close(tmp_fd)
        out = os.path.join(source_dir, output_stem + ".mp4")

        try:
            with open(listfile, "w", encoding="utf-8") as f:
                for v in vids:
                    f.write("file '%s'\n" % _concat_quote(v))

            cmd = [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", listfile, "-c", "copy", tmp]
            r = subprocess.run(cmd, capture_output=True)
            if r.returncode != 0:
                err = (r.stderr or b"").decode("utf-8", "ignore")
                _log("[H3导演台] 无损拼接失败，改用转码合并…\n" + err[-400:])
                cmd = [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", listfile,
                       "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
                       "-c:a", "aac", "-b:a", "192k", tmp]
                r = subprocess.run(cmd, capture_output=True)
                if r.returncode != 0:
                    err = (r.stderr or b"").decode("utf-8", "ignore")
                    raise RuntimeError("[H3导演台] ffmpeg 合并失败: " + err[-600:])

            os.replace(tmp, out)
        finally:
            for path in (listfile, tmp):
                try:
                    os.remove(path)
                except OSError:
                    pass
        _log("[H3导演台] 合并完成 -> %s" % out)
        return ()

    @classmethod
    def IS_CHANGED(cls, 段数, 输出文件名, project_id="", **kwargs):
        source_dir = _merge_source_dir(project_id)
        sig = []
        for i in range(1, 段数 + 1):
            p = _video_path(i, project_id, source_dir=source_dir)
            sig.append(str(os.path.getmtime_ns(p)) if p else "x")
        return "%s|%s" % (_safe_output_stem(输出文件名), "|".join(sig))


NODE_CLASS_MAPPINGS = {
    "H3DirectorTailFrame": H3DirectorTailFrame,
    "H3DirectorMerge": H3DirectorMerge,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3DirectorTailFrame": "导演台·上一段尾帧",
    "H3DirectorMerge": "导演台·合并成片",
}
