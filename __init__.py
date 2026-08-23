# -*- coding: utf-8 -*-
from .nodes import NODE_CLASS_MAPPINGS as _N1, NODE_DISPLAY_NAME_MAPPINGS as _D1
from .studio_node import NODE_CLASS_MAPPINGS as _N2, NODE_DISPLAY_NAME_MAPPINGS as _D2
from .text_merge_node import NODE_CLASS_MAPPINGS as _N3, NODE_DISPLAY_NAME_MAPPINGS as _D3
from .aliyun_oss_nodes import NODE_CLASS_MAPPINGS as _N4, NODE_DISPLAY_NAME_MAPPINGS as _D4

NODE_CLASS_MAPPINGS = {**_N1, **_N2, **_N3, **_N4}
NODE_DISPLAY_NAME_MAPPINGS = {**_D1, **_D2, **_D3, **_D4}

WEB_DIRECTORY = "./web"

try:
    from . import routes
    routes.register_routes()
except Exception as e:
    print("[H3导演台] 路由注册失败:", e)

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
