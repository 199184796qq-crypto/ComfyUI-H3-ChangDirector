# -*- coding: utf-8 -*-
"""Dynamic STRING input merger for ComfyUI workflows."""

import re


class _FlexibleStringInputs(dict):
    """Allow the browser to add text_1, text_2, ... ports at runtime.

    ComfyUI validates optional input names against ``INPUT_TYPES``.  Dynamic
    ports do not exist in the original node schema, so this mapping explicitly
    accepts any optional key while still declaring its type as STRING.
    """

    def __getitem__(self, _key):
        return ("STRING",)

    def __contains__(self, _key):
        return True


class H3DynamicTextMerge:
    """Merge any number of upstream text inputs in their visible port order."""

    CATEGORY = "H3 长序列分镜融合台/文本"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("合并文本",)
    FUNCTION = "merge"
    # 让节点即使未连接下游，也会被 ComfyUI 的队列单独执行并刷新预览。
    OUTPUT_NODE = True
    DESCRIPTION = "连接一个文本输入后会自动出现下一个输入；按顺序用分隔符合并所有非空文本。"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "分隔符": ("STRING", {
                    "default": "===",
                    "multiline": False,
                    "tooltip": "每段文本之间的分隔符。输出时会独占一行，例如：文本A\\n===\\n文本B。",
                }),
            },
            # text_1、text_2… 由前端按连接情况动态创建。
            "optional": _FlexibleStringInputs(),
        }

    def merge(self, 分隔符="===", **kwargs):
        def port_number(item):
            match = re.fullmatch(r"text_(\d+)", item[0])
            return int(match.group(1)) if match else 10 ** 9

        parts = []
        for name, value in sorted(kwargs.items(), key=port_number):
            if not re.fullmatch(r"text_\d+", name) or value is None:
                continue
            text = str(value)
            if text.strip():
                parts.append(text)

        separator = str(分隔符 if 分隔符 is not None else "===")
        merged = ("\n" + separator + "\n").join(parts)
        return {"ui": {"merged_text": [merged]}, "result": (merged,)}


NODE_CLASS_MAPPINGS = {
    "H3DynamicTextMerge": H3DynamicTextMerge,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3DynamicTextMerge": "动态文本合并（自动扩展输入）",
}
