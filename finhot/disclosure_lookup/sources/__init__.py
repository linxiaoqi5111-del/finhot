"""源适配器集合。

延迟加载：各源在 get_source() 时按需 import，避免包导入即拉起 akshare 等重依赖。
"""
from __future__ import annotations

import importlib

# name -> (module_path, class_name)
SOURCE_REGISTRY: dict[str, tuple[str, str]] = {
    "cninfo": ("disclosure_lookup.sources.cninfo", "CninfoSource"),
    "irm_szse": ("disclosure_lookup.sources.irm", "IrmSource"),
    "sse_einteract": ("disclosure_lookup.sources.irm", "SseEInteractSource"),
    "inquiry": ("disclosure_lookup.sources.inquiry", "InquirySource"),
}


def get_source(name: str):
    """按名字延迟 import 并实例化一个 Source。"""
    if name not in SOURCE_REGISTRY:
        raise KeyError(f"unknown source: {name}")
    mod_path, cls_name = SOURCE_REGISTRY[name]
    mod = importlib.import_module(mod_path)
    return getattr(mod, cls_name)()
