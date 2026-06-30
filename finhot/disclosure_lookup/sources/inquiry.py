"""交易所监管问询函适配器（上交所 / 深交所）。

数据来源：akshare（方法内延迟 import）。问询函本身是「监管动作」，其价值常在
**问到了什么**（关注点）与**公司回复**（澄清/否认/补充披露）——回复里常含 L3 反证。
口径：问询函标题/列表入 cache；回复正文片段进 raw_excerpt（仍不下 PDF 全文）。
"""
from __future__ import annotations

from typing import Optional

from ..schema import DisclosureRecord
from .base import BaseSource
from .cninfo import _load_fc, _se_date, _to_record, resolve_orgid

# 问询函/监管函特征词：分类码无专属问询函，改用 cninfo searchkey + 标题二次校验。
INQUIRY_KEYWORDS = ["问询函", "关注函", "监管工作函", "监管函"]


class InquirySource(BaseSource):
    name = "inquiry"
    authority = 3  # 交易所/监管动作，权威性高

    def _collect(
        self,
        *,
        days: int,
        searchkeys: list[str],
        stock: str = "",
        codes: Optional[list[str]] = None,
    ) -> list[DisclosureRecord]:
        """按 searchkeys 逐词检索 → 标题须含问询特征词才保留（粗筛→准入门）。"""
        fc = _load_fc()
        client = fc.CninfoClient(rate_limit_seconds=1.5)
        codeset = set(codes) if codes else None
        se = _se_date(days)
        out: dict[str, DisclosureRecord] = {}
        for kw in searchkeys:
            for item in client.iter_announcements(
                max_pages=3, page_size=50, se_date=se, stock=stock, searchkey=kw
            ):
                rec = fc.normalize_raw(item)
                aid = rec.get("announcement_id")
                if not aid or aid in out:
                    continue
                if codeset and rec.get("sec_code") not in codeset:
                    continue
                title = rec.get("title", "")
                hit = [k for k in INQUIRY_KEYWORDS if k in title]
                if not hit:
                    continue  # searchkey 可能宽匹配，标题非问询类则丢弃
                out[aid] = _to_record(rec, source=self.name, matched=hit)
        return list(out.values())

    def search_company(
        self, code: str, name: str = "", *, days: int = 30
    ) -> list[DisclosureRecord]:
        stock = f"{code},{resolve_orgid(code)}"
        return self._collect(days=days, searchkeys=INQUIRY_KEYWORDS, stock=stock)

    def search_keyword(
        self, keyword: str, *, days: int = 30, codes: Optional[list[str]] = None
    ) -> list[DisclosureRecord]:
        # 问询范围内按关键词找：用 keyword 检索，仅保留标题含问询特征者。
        return self._collect(days=days, searchkeys=[keyword], codes=codes)
