# -*- coding: utf-8 -*-
"""Standalone MiniMax H3 Remix model loader.

The Remix checkpoint already contains the weights needed by both the FL2VA
and REF2VA conditioning paths.  This node intentionally exposes only the
checkpoint selector and returns a regular ComfyUI MODEL, so it can be reused
outside the Director as well.
"""

from __future__ import annotations

import folder_paths
import nodes as comfy_nodes


_GGUF_EXTENSIONS = (".gguf",)


def _model_choices():
    """Return all diffusion checkpoints, with Remix/H3 files shown first."""
    choices = set()
    for category in ("diffusion_models", "unet", "unet_gguf"):
        try:
            choices.update(folder_paths.get_filename_list(category))
        except (KeyError, ValueError):
            continue

    def sort_key(name):
        normalized = str(name).replace("\\", "/").lower()
        is_remix = "remix" in normalized
        is_h3 = "minimax" in normalized or "h3" in normalized
        return (not is_remix, not is_h3, normalized)

    return sorted(choices, key=sort_key)


def _gguf_loader_class():
    registry = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {})
    for name in ("UnetLoaderGGUF", "UNETLoaderGGUF", "UnetLoaderGGUFAdvanced"):
        loader_class = registry.get(name) if hasattr(registry, "get") else None
        if loader_class is not None:
            return loader_class
    return None


def _mark_as_h3_remix(model, model_name):
    """Attach advisory metadata without changing the standard MODEL type."""
    for target in (model, getattr(model, "model", None)):
        if target is None:
            continue
        try:
            target.h3_checkpoint_kind = "remix"
            target.h3_checkpoint_name = str(model_name)
        except Exception:
            pass
    return model


class H3RemixModelLoader:
    """Load one Remix checkpoint for automatic FL2VA/REF2VA use."""

    CATEGORY = "H3 长序列分镜融合台/模型加载"
    FUNCTION = "load_model"
    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    DESCRIPTION = (
        "加载一个 MiniMax H3 Remix 混合模型并输出标准 MODEL。"
        "导演台会按本段素材自动选择 FL2VA 或 REF2VA 条件路径；"
        "同时自动识别 safetensors 与 GGUF 文件。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "remix_model": (_model_choices(), {
                    "tooltip": "选择同时兼容 FL2VA 与 REF2VA 的 MiniMax H3 Remix 模型。",
                }),
            },
        }

    def load_model(self, remix_model):
        model_name = str(remix_model or "").strip()
        if not model_name:
            raise ValueError("请选择 MiniMax H3 Remix 混合模型。")

        if model_name.lower().endswith(_GGUF_EXTENSIONS):
            loader_class = _gguf_loader_class()
            if loader_class is None:
                raise RuntimeError(
                    "检测到 GGUF Remix 模型，但 ComfyUI-GGUF 未安装或尚未加载。"
                    "请安装/启用 ComfyUI-GGUF 后重启 ComfyUI。"
                )
            result = loader_class().load_unet(model_name)
        else:
            result = comfy_nodes.UNETLoader().load_unet(model_name, "default")

        model = result[0]
        return (_mark_as_h3_remix(model, model_name),)


NODE_CLASS_MAPPINGS = {
    "H3RemixModelLoader": H3RemixModelLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3RemixModelLoader": "H3 Remix 混合模型加载器（自动识别）",
}
