"""统一数据契约：所有源归一化到 DisclosureRecord。

教学备注（适配器模式）：把不同源的异构返回收敛到同一个 dataclass，上层
（cache / triage / 问答）只认这一个结构；新增源只写一个适配器即可，互不影响。
这跟「驱动程序统一接口、内核不关心硬件差异」是同一个套路。
"""
from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field
from typing import Any, Optional

# 来源可信度（source_authority）建议取值
AUTHORITY_EXCHANGE = 3  # 交易所公告 / 巨潮正式披露
AUTHORITY_INTERACT = 2  # 互动易 / 上证 e 互动（官方问答）
AUTHORITY_MEDIA = 1  # 媒体 / 二手转述


@dataclass
class DisclosureRecord:
    """一条披露记录的统一表示（字段对应需求里的返回结构）。"""

    company_name: str
    company_code: str
    source: str  # cninfo | irm_szse | sse_einteract | inquiry_sse ...
    title: str
    url: str
    published_at: str  # ISO8601 +08:00
    summary: str = ""  # 元数据级摘要，不含 PDF 正文
    raw_excerpt: str = ""  # 标题 / 互动问答原文片段
    matched_keywords: list[str] = field(default_factory=list)
    source_authority: int = AUTHORITY_EXCHANGE
    fact_type: Optional[str] = None  # 复用 cninfo 分类：order_contract / mass_production ...

    # 去重键：默认由 (source, code, title, date) 派生
    doc_hash: str = ""

    # triage 阶段补全
    triage_level: Optional[str] = None  # P0 / P1 / P2 / P3
    triage_score: Optional[float] = None

    def __post_init__(self) -> None:
        if not self.doc_hash:
            self.doc_hash = make_doc_hash(
                self.source, self.company_code, self.title, self.published_at
            )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def make_doc_hash(source: str, code: str, title: str, published_at: str) -> str:
    """稳定去重键：同一条披露在不同查询路径下应得到相同 hash。

    只取日期到「天」，避免毫秒/时区差异造成同条记录 hash 不一致。
    """
    raw = "|".join(
        (source or "", code or "", (title or "").strip(), (published_at or "")[:10])
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()
