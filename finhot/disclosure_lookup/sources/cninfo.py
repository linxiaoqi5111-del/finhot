"""巨潮适配器：复用 skills/cninfo-rss/scripts/fetch_cninfo.py，不重写抓取。

设计（复用而非重写）：
- 通过 sys.path 注入 cninfo-rss/scripts 目录后 `import fetch_cninfo`，调用其
  CninfoClient + normalize_raw + classify，再映射成 DisclosureRecord。
- 按公司查走 stock 精确查询（fetch_cninfo.org_id_of_code）；按关键词走 searchkey。
- 注意：fetch_cninfo 顶部 `import yaml`，故运行环境需装 PyYAML（见 requirements.txt）。
  import 放在方法内部，避免本模块被导入时就硬依赖 PyYAML。
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

from ..schema import AUTHORITY_EXCHANGE, DisclosureRecord
from .base import BaseSource

_FC = None  # fetch_cninfo 模块单例（懒加载）


def _load_fc():
    """sys.path 注入 cninfo-rss/scripts 后 import fetch_cninfo（懒加载、单例）。

    parents[3] = 仓库根：finhot/finhot/disclosure_lookup/sources/cninfo.py 上溯 4 级。
    inquiry.py 与 lookup._resolve_company 也复用本函数，保证只注入一次。
    """
    global _FC
    if _FC is None:
        scripts = Path(__file__).resolve().parents[3] / "skills" / "cninfo-rss" / "scripts"
        if str(scripts) not in sys.path:
            sys.path.insert(0, str(scripts))
        import fetch_cninfo as fc  # noqa: E402 - 需先注入 sys.path

        _FC = fc
    return _FC


TOP_SEARCH_URL = "http://www.cninfo.com.cn/new/information/topSearch/query"
_ORGID_CACHE: dict[str, str] = {}


def top_search(keyword: str, max_num: int = 10) -> list[dict]:
    """cninfo 股票联想搜索：keyWord → [{code, orgId, name, category, delisted}]。

    用于 code↔name 互查与拿**真实 orgId**——科创板等合成 orgId（gssh0xxx）不被公告
    接口接受（实测返回 0），必须用本接口给出的 orgId（如 688323 → 9900041792）。
    """
    fc = _load_fc()
    data = urllib.parse.urlencode({"keyWord": keyword, "maxNum": str(max_num)}).encode()
    req = urllib.request.Request(
        TOP_SEARCH_URL,
        data=data,
        headers={
            "User-Agent": fc.UA,
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": "http://www.cninfo.com.cn/",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        arr = json.loads(resp.read().decode("utf-8", "replace")) or []
    out: list[dict] = []
    for x in arr:
        code = (x.get("code") or "").strip()
        if not code:
            continue
        out.append(
            {
                "code": code,
                "orgId": (x.get("orgId") or "").strip(),
                "name": (x.get("zwjc") or "").strip(),
                "category": (x.get("category") or "").strip(),
                "delisted": str(x.get("delisted")).lower() == "true",
            }
        )
    return out


def resolve_orgid(code: str) -> str:
    """code → 真实 orgId（进程内缓存；topSearch 失败时兜底用合成 orgId）。"""
    if code in _ORGID_CACHE:
        return _ORGID_CACHE[code]
    org = ""
    try:
        for r in top_search(code):
            if r["code"] == code and r["orgId"]:
                org = r["orgId"]
                break
    except Exception:  # noqa: BLE001 - 联想搜索失败则兜底
        org = ""
    if not org:
        org = _load_fc().org_id_of_code(code)
    _ORGID_CACHE[code] = org
    return org


def name_of_code(code: str) -> str:
    """code → 中文简称（topSearch），失败返回 ''。"""
    try:
        for r in top_search(code):
            if r["code"] == code:
                return r["name"]
    except Exception:  # noqa: BLE001
        pass
    return ""


def _se_date(days: int) -> str:
    """构造 cninfo seDate 区间 'YYYY-MM-DD~YYYY-MM-DD'（北京时区）。"""
    fc = _load_fc()
    today = dt.datetime.now(fc.CN_TZ).date()
    return f"{today - dt.timedelta(days=days)}~{today}"


def _to_record(
    rec: dict, *, source: str, matched: Optional[list[str]] = None
) -> DisclosureRecord:
    """fetch_cninfo 归一化记录 dict → DisclosureRecord。"""
    return DisclosureRecord(
        company_name=rec.get("sec_name", ""),
        company_code=rec.get("sec_code", ""),
        source=source,
        title=rec.get("title", ""),
        url=rec.get("detail_url") or rec.get("pdf_url") or "",
        published_at=rec.get("published_at", ""),
        summary=rec.get("announcement_type") or rec.get("title", ""),
        raw_excerpt=rec.get("title", ""),
        matched_keywords=matched or [],
        source_authority=AUTHORITY_EXCHANGE,
    )


class CninfoSource(BaseSource):
    name = "cninfo"
    authority = AUTHORITY_EXCHANGE

    def _collect(
        self,
        client,
        *,
        se: str,
        matched: Optional[list[str]] = None,
        codeset: Optional[set] = None,
        max_pages: int = 5,
        **page_kwargs,
    ) -> list[DisclosureRecord]:
        """iter_announcements → normalize → 去重/按 codeset 过滤 → map。"""
        fc = _load_fc()
        out, seen = [], set()
        for item in client.iter_announcements(
            max_pages=max_pages, page_size=50, se_date=se, **page_kwargs
        ):
            rec = fc.normalize_raw(item)
            aid = rec.get("announcement_id")
            if not aid or aid in seen:
                continue
            if codeset and rec.get("sec_code") not in codeset:
                continue
            seen.add(aid)
            out.append(_to_record(rec, source=self.name, matched=matched))
        return out

    def search_company(
        self, code: str, name: str = "", *, days: int = 30
    ) -> list[DisclosureRecord]:
        fc = _load_fc()
        client = fc.CninfoClient(rate_limit_seconds=1.5)
        se = _se_date(days)
        recs = self._collect(client, se=se, stock=f"{code},{resolve_orgid(code)}")
        if not recs:  # 兜底：按简称做标题检索（公告标题通常以公司简称开头）
            nm = name or name_of_code(code)
            if nm:
                recs = self._collect(client, se=se, searchkey=nm, codeset={code})
        return recs

    def search_keyword(
        self, keyword: str, *, days: int = 30, codes: Optional[list[str]] = None
    ) -> list[DisclosureRecord]:
        fc = _load_fc()
        client = fc.CninfoClient(rate_limit_seconds=1.5)
        codeset = set(codes) if codes else None
        return self._collect(
            client, se=_se_date(days), searchkey=keyword, matched=[keyword], codeset=codeset
        )
