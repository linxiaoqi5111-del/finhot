"""disclosure_lookup · 实时查新 API + 选择性 L3 沉淀（设计见 DESIGN.md）。

Phase 0：仅接口骨架（签名 / 数据契约），业务逻辑未实现。
分包：
  schema        统一数据契约 DisclosureRecord
  sources/      源适配器（cninfo / irm / inquiry / ...）
  cache         SQLite cache-aside
  triage        evidence_triage 打分器 → P0-P3
  evidence_card 证据卡生成
  lookup        编排入口（service 函数）
  cli           命令行
"""
from __future__ import annotations

__version__ = "0.0.0"
