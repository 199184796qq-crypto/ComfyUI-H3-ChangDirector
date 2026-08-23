import hashlib
import hmac
import mimetypes
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

import numpy as np
import requests
import torch
from PIL import Image

import folder_paths


ENV_ENDPOINT = "ALIYUN_OSS_ENDPOINT"
ENV_REGION = "ALIYUN_OSS_REGION"
ENV_BUCKET = "ALIYUN_OSS_BUCKET"
ENV_ACCESS_KEY_ID = "ALIYUN_OSS_ACCESS_KEY_ID"
ENV_ACCESS_KEY_SECRET = "ALIYUN_OSS_ACCESS_KEY_SECRET"
ENV_SECURITY_TOKEN = "ALIYUN_OSS_SECURITY_TOKEN"


def _env(name):
    return os.environ.get(name, "")


def _value(value, env_name):
    return value.strip() or _env(env_name).strip()


def _object_key(key):
    key = key.replace("\\", "/").strip("/")
    if not key or any(part in ("", ".", "..") for part in key.split("/")):
        raise ValueError("object_key 必须是有效的 OSS 对象键，且不能包含 . 或 .. 路径段。")
    return key


def _object_prefix(value):
    """Normalize the configurable H3 object-key prefix to exactly one slash."""
    value = str(value or "").replace("\\", "/").strip()
    if not value:
        raise ValueError("object_key 不能为空。请填写 OSS 中保存 H3 latent 的目录，例如 H3。")
    return _object_key(value) + "/"


def _required_config(endpoint, region, bucket, access_key_id, access_key_secret, security_token, use_system_proxy, object_key=None):
    config = {
        "endpoint": _value(endpoint, ENV_ENDPOINT),
        "region": _value(region, ENV_REGION),
        "bucket": _value(bucket, ENV_BUCKET),
        "access_key_id": _value(access_key_id, ENV_ACCESS_KEY_ID),
        "access_key_secret": _value(access_key_secret, ENV_ACCESS_KEY_SECRET),
        "security_token": _value(security_token, ENV_SECURITY_TOKEN),
        "use_system_proxy": use_system_proxy,
    }
    missing = [name for name in ("endpoint", "region", "bucket", "access_key_id", "access_key_secret") if not config[name]]
    if missing:
        raise ValueError("缺少 OSS 配置：" + ", ".join(missing) + "。可在节点填写，或设置对应的 ALIYUN_OSS_* 环境变量。")
    if object_key is not None:
        config["object_key"] = _object_prefix(object_key)
    return config


def _endpoint_url(endpoint, bucket, key):
    endpoint = endpoint if "://" in endpoint else f"https://{endpoint}"
    parts = urlsplit(endpoint)
    if not parts.scheme or not parts.netloc or parts.path not in ("", "/"):
        raise ValueError("endpoint 应为 OSS 区域端点，例如 https://oss-cn-hangzhou.aliyuncs.com。")
    host = parts.netloc
    if not host.startswith(f"{bucket}."):
        host = f"{bucket}.{host}"
    return urlunsplit((parts.scheme, host, "/" + quote(key, safe="/-_.~"), "", ""))


def _signature_key(secret, date, region):
    key = hmac.new(("aliyun_v4" + secret).encode("utf-8"), date.encode("utf-8"), hashlib.sha256).digest()
    key = hmac.new(key, region.encode("utf-8"), hashlib.sha256).digest()
    key = hmac.new(key, b"oss", hashlib.sha256).digest()
    return hmac.new(key, b"aliyun_v4_request", hashlib.sha256).digest()


def _signed_headers(method, key, config, content_type=""):
    now = datetime.now(timezone.utc)
    timestamp = now.strftime("%Y%m%dT%H%M%SZ")
    date = timestamp[:8]
    headers = {"x-oss-content-sha256": "UNSIGNED-PAYLOAD", "x-oss-date": timestamp}
    if content_type:
        headers["Content-Type"] = content_type
    if config["security_token"]:
        headers["x-oss-security-token"] = config["security_token"]

    signed = []
    for name, value in headers.items():
        lower_name = name.lower()
        if lower_name.startswith("x-oss-") or lower_name in ("content-type", "content-md5"):
            signed.append((lower_name, " ".join(value.strip().split())))
    signed.sort()
    canonical_headers = "".join(f"{name}:{value}\n" for name, value in signed)
    canonical_uri = quote(f"/{config['bucket']}/{key}", safe="/-_.~")
    canonical_request = f"{method}\n{canonical_uri}\n\n{canonical_headers}\n\nUNSIGNED-PAYLOAD"
    scope = f"{date}/{config['region']}/oss/aliyun_v4_request"
    string_to_sign = "\n".join(("OSS4-HMAC-SHA256", timestamp, scope, hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()))
    signature = hmac.new(_signature_key(config["access_key_secret"], date, config["region"]), string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    headers["Authorization"] = f"OSS4-HMAC-SHA256 Credential={config['access_key_id']}/{scope},Signature={signature}"
    return headers


def _request(method, key, config, **kwargs):
    content_type = kwargs.pop("content_type", "")
    url = _endpoint_url(config["endpoint"], config["bucket"], key)
    session = requests.Session()
    session.trust_env = config["use_system_proxy"]
    response = session.request(method, url, headers=_signed_headers(method, key, config, content_type), timeout=(10, 600), **kwargs)
    if not response.ok:
        detail = response.text[:1000].strip()
        response.close()
        raise RuntimeError(f"OSS {method} 请求失败（HTTP {response.status_code}）：{detail}")
    return response


def _config_inputs(include_object_key=False):
    inputs = {
        "endpoint": ("STRING", {"default": _env(ENV_ENDPOINT), "multiline": False}),
        "region": ("STRING", {"default": _env(ENV_REGION), "multiline": False}),
        "bucket": ("STRING", {"default": _env(ENV_BUCKET), "multiline": False}),
        # ``password`` is understood by some ComfyUI frontends.  The bundled
        # frontend extension also applies the same masking to older versions.
        "access_key_id": ("STRING", {"default": "", "multiline": False, "password": True}),
        "access_key_secret": ("STRING", {"default": "", "multiline": False, "password": True}),
        "security_token": ("STRING", {"default": "", "multiline": False}),
        "use_system_proxy": ("BOOLEAN", {"default": False}),
    }
    # Append this field to preserve the positional widget order of existing
    # workflows that were saved before the configurable H3 prefix was added.
    if include_object_key:
        inputs["object_key"] = ("STRING", {"default": "H3", "multiline": False,
                                           "tooltip": "H3 latent 的 OSS 目录，例如 H3 或 project_a/H3；程序会自动补一个 /。"})
    return inputs


def _config(endpoint, region, bucket, access_key_id, access_key_secret, security_token, use_system_proxy, object_key=None):
    return _required_config(endpoint, region, bucket, access_key_id, access_key_secret, security_token, use_system_proxy, object_key)


class AliyunOSSConfig:
    CATEGORY = "Aliyun OSS"
    RETURN_TYPES = ("ALIYUN_OSS_CONFIG",)
    RETURN_NAMES = ("oss_config",)
    FUNCTION = "build"
    DESCRIPTION = "提供阿里云 OSS REST 配置，可连接到支持 ALIYUN_OSS_CONFIG 的节点。"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": _config_inputs(include_object_key=True)}

    def build(self, endpoint, region, bucket, access_key_id, access_key_secret, security_token, use_system_proxy, object_key="H3"):
        return (_config(endpoint, region, bucket, access_key_id, access_key_secret, security_token, use_system_proxy, object_key),)


class AliyunOSSUploadFile:
    CATEGORY = "Aliyun OSS"
    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("object_key", "oss_uri", "etag")
    FUNCTION = "upload"
    OUTPUT_NODE = True
    DESCRIPTION = "通过 OSS REST API 上传 ComfyUI input 目录中的文件。密钥为空时读取 ALIYUN_OSS_* 环境变量。"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"source_file": (folder_paths.get_input_directory(), {"image_upload": True}), "object_key": ("STRING", {"default": "comfyui/example.png", "multiline": False}), **_config_inputs()}}

    def upload(self, source_file, object_key, endpoint, region, bucket, access_key_id, access_key_secret, security_token, use_system_proxy):
        source_path = Path(folder_paths.get_annotated_filepath(source_file))
        if not source_path.is_file():
            raise FileNotFoundError(f"找不到输入文件：{source_file}")
        key = _object_key(object_key)
        config = _config(endpoint, region, bucket, access_key_id, access_key_secret, security_token, use_system_proxy)
        content_type = mimetypes.guess_type(source_path.name)[0] or "application/octet-stream"
        with source_path.open("rb") as source:
            response = _request("PUT", key, config, data=source, content_type=content_type)
        etag = response.headers.get("ETag", "").strip('"')
        response.close()
        return key, f"oss://{config['bucket']}/{key}", etag


class AliyunOSSDownloadFile:
    CATEGORY = "Aliyun OSS"
    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("saved_file", "object_key", "etag")
    FUNCTION = "download"
    OUTPUT_NODE = True
    DESCRIPTION = "通过 OSS REST API 下载对象到 ComfyUI output/oss_downloads 目录。"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"object_key": ("STRING", {"default": "comfyui/example.png", "multiline": False}), **_config_inputs()}}

    def download(self, object_key, endpoint, region, bucket, access_key_id, access_key_secret, security_token, use_system_proxy):
        key = _object_key(object_key)
        config = _config(endpoint, region, bucket, access_key_id, access_key_secret, security_token, use_system_proxy)
        destination = Path(folder_paths.get_output_directory()) / "oss_downloads" / Path(*key.split("/"))
        destination.parent.mkdir(parents=True, exist_ok=True)
        response = _request("GET", key, config, stream=True)
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as temporary:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    temporary.write(chunk)
            temporary_path = Path(temporary.name)
        etag = response.headers.get("ETag", "").strip('"')
        response.close()
        temporary_path.replace(destination)
        return str(destination), key, etag


class AliyunOSSUploadImage:
    CATEGORY = "Aliyun OSS"
    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("object_key", "oss_uri", "etag")
    FUNCTION = "upload"
    OUTPUT_NODE = True
    DESCRIPTION = "通过 OSS REST API 将 IMAGE 保存为 PNG 后上传。"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "object_key": ("STRING", {"default": "comfyui/image.png", "multiline": False}), **_config_inputs()}}

    def upload(self, images, object_key, endpoint, region, bucket, access_key_id, access_key_secret, security_token, use_system_proxy):
        if len(images) != 1:
            raise ValueError("上传图片节点一次只能上传一张图。请使用批处理节点逐张处理。")
        key = _object_key(object_key)
        if not key.lower().endswith(".png"):
            key += ".png"
        config = _config(endpoint, region, bucket, access_key_id, access_key_secret, security_token, use_system_proxy)
        image = Image.fromarray(np.clip(images[0].cpu().numpy() * 255.0, 0, 255).astype(np.uint8))
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temporary:
            temporary_path = temporary.name
        try:
            image.save(temporary_path, format="PNG")
            with open(temporary_path, "rb") as source:
                response = _request("PUT", key, config, data=source, content_type="image/png")
            etag = response.headers.get("ETag", "").strip('"')
            response.close()
        finally:
            if os.path.exists(temporary_path):
                os.remove(temporary_path)
        return key, f"oss://{config['bucket']}/{key}", etag


class AliyunOSSDownloadImage:
    CATEGORY = "Aliyun OSS"
    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("image", "mask", "saved_file")
    FUNCTION = "download"
    DESCRIPTION = "通过 OSS REST API 下载图片并输出为 IMAGE。"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"object_key": ("STRING", {"default": "comfyui/image.png", "multiline": False}), **_config_inputs()}}

    def download(self, object_key, endpoint, region, bucket, access_key_id, access_key_secret, security_token, use_system_proxy):
        key = _object_key(object_key)
        config = _config(endpoint, region, bucket, access_key_id, access_key_secret, security_token, use_system_proxy)
        destination = Path(folder_paths.get_output_directory()) / "oss_downloads" / Path(*key.split("/"))
        destination.parent.mkdir(parents=True, exist_ok=True)
        response = _request("GET", key, config, stream=True)
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as temporary:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    temporary.write(chunk)
            temporary_path = Path(temporary.name)
        response.close()
        temporary_path.replace(destination)
        with Image.open(destination) as source:
            pixels = np.array(source.convert("RGBA")).astype(np.float32) / 255.0
        rgb = torch.from_numpy(pixels[:, :, :3])[None,]
        mask = 1.0 - torch.from_numpy(pixels[:, :, 3])
        return rgb, mask[None,], str(destination)


class AliyunOSSUploadLatent:
    CATEGORY = "Aliyun OSS"
    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("object_key", "oss_uri", "etag")
    FUNCTION = "upload"
    OUTPUT_NODE = True
    DESCRIPTION = "通过 OSS REST API 上传工作流中的 LATENT，保存为 PyTorch .pt 文件。"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"latent": ("LATENT",), "object_key": ("STRING", {"default": "comfyui/latent.pt", "multiline": False}), **_config_inputs()}}

    def upload(self, latent, object_key, endpoint, region, bucket, access_key_id, access_key_secret, security_token, use_system_proxy):
        if not isinstance(latent, dict) or not isinstance(latent.get("samples"), torch.Tensor):
            raise ValueError("输入必须是包含 samples 张量的 LATENT。")
        key = _object_key(object_key)
        if not key.lower().endswith(".pt"):
            key += ".pt"
        config = _config(endpoint, region, bucket, access_key_id, access_key_secret, security_token, use_system_proxy)
        with tempfile.NamedTemporaryFile(suffix=".pt", delete=False) as temporary:
            temporary_path = temporary.name
        try:
            torch.save(latent, temporary_path)
            with open(temporary_path, "rb") as source:
                response = _request("PUT", key, config, data=source, content_type="application/octet-stream")
            etag = response.headers.get("ETag", "").strip('"')
            response.close()
        finally:
            if os.path.exists(temporary_path):
                os.remove(temporary_path)
        return key, f"oss://{config['bucket']}/{key}", etag


class AliyunOSSDownloadLatent:
    CATEGORY = "Aliyun OSS"
    RETURN_TYPES = ("LATENT", "STRING")
    RETURN_NAMES = ("latent", "saved_file")
    FUNCTION = "download"
    DESCRIPTION = "通过 OSS REST API 下载 .pt 文件，并恢复为 LATENT。仅加载由上传 latent 节点生成的可信文件。"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"object_key": ("STRING", {"default": "comfyui/latent.pt", "multiline": False}), **_config_inputs()}}

    def download(self, object_key, endpoint, region, bucket, access_key_id, access_key_secret, security_token, use_system_proxy):
        key = _object_key(object_key)
        config = _config(endpoint, region, bucket, access_key_id, access_key_secret, security_token, use_system_proxy)
        destination = Path(folder_paths.get_output_directory()) / "oss_downloads" / Path(*key.split("/"))
        destination.parent.mkdir(parents=True, exist_ok=True)
        response = _request("GET", key, config, stream=True)
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as temporary:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    temporary.write(chunk)
            temporary_path = Path(temporary.name)
        response.close()
        temporary_path.replace(destination)
        latent = torch.load(destination, map_location="cpu", weights_only=True)
        if not isinstance(latent, dict) or not isinstance(latent.get("samples"), torch.Tensor):
            raise ValueError("该对象不是由阿里云 OSS 上传 latent 节点生成的有效 LATENT 文件。")
        return latent, str(destination)


NODE_CLASS_MAPPINGS = {
    "AliyunOSSConfig": AliyunOSSConfig,
    "AliyunOSSUploadFile": AliyunOSSUploadFile,
    "AliyunOSSDownloadFile": AliyunOSSDownloadFile,
    "AliyunOSSUploadImage": AliyunOSSUploadImage,
    "AliyunOSSDownloadImage": AliyunOSSDownloadImage,
    "AliyunOSSUploadLatent": AliyunOSSUploadLatent,
    "AliyunOSSDownloadLatent": AliyunOSSDownloadLatent,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AliyunOSSConfig": "阿里云 OSS 配置（REST）",
    "AliyunOSSUploadFile": "阿里云 OSS 上传文件（REST）",
    "AliyunOSSDownloadFile": "阿里云 OSS 下载文件（REST）",
    "AliyunOSSUploadImage": "阿里云 OSS 上传图片（REST）",
    "AliyunOSSDownloadImage": "阿里云 OSS 下载图片（REST）",
    "AliyunOSSUploadLatent": "阿里云 OSS 上传 Latent（REST）",
    "AliyunOSSDownloadLatent": "阿里云 OSS 下载 Latent（REST）",
}

