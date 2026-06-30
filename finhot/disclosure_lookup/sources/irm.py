"""互动易(深交所) + 上证 e 互动 适配器。

数据来源：akshare（方法内延迟 import，隔离重依赖；akshare 抽风不影响巨潮路径）：
  - 互动易（深）：stock_irm_cninfo（提问列表）/ stock_irm_ans_cninfo（答复）
  - 上证 e 互动：stock_sns_sseinfo
口径：互动问答的「答复正文」是 raw_excerpt/summary 主来源；fact_hardness 通常 ≤ 公告，
      多数落 P1/P2，但「明确否认/确认客户验证」等可升 P0（反证或硬确认）。
"""
from __future__ import annotations

import datetime as dt
import inspect
import json
import os
import re
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

from ..schema import AUTHORITY_INTERACT, DisclosureRecord
from .base import BaseSource


def _akshare():
    """延迟 import akshare（重依赖，隔离；抽风不影响巨潮路径）。"""
    import akshare as ak

    return ak


# 网络抖动根因（实测）：本机 VPN 配了 macOS 系统代理，requests 默认走它，对国内源
# （尤其 sns.sseinfo.com）间歇握手超时。国内源直连才稳 → _no_proxy 绕过系统代理。
# 叠加有限重试兜剩余瞬时抖动。
_RETRIES = 2


@contextmanager
def _no_proxy():
    """临时绕过系统/VPN 代理（国内源直连）。akshare 用模块级 requests（trust_env=True
    会读系统代理），故用 no_proxy 环境变量覆盖；finally 还原，无全局副作用。"""
    old = os.environ.get("no_proxy")
    os.environ["no_proxy"] = "*"
    try:
        yield
    finally:
        if old is None:
            os.environ.pop("no_proxy", None)
        else:
            os.environ["no_proxy"] = old


def _fetch_with_retry(fetch):
    """对网络调用做有限重试（瞬时 SSL/超时）。失败到顶抛最后一次异常。"""
    last: Optional[BaseException] = None
    for attempt in range(_RETRIES + 1):
        try:
            return fetch()
        except Exception as exc:  # noqa: BLE001 - 网络/SSL 抖动重试
            last = exc
            if attempt < _RETRIES:
                time.sleep(1.0 * (attempt + 1))
    assert last is not None
    raise last


# ---- SSE uid 映射文件缓存 ----
# akshare 的 stock_sns_sseinfo 每次都调 _fetch_stock_uid 爬 72 页 allcompany.do 建全市场
# code→uid 映射（又慢又抖）。这里把映射落盘，猴补丁 _fetch_stock_uid 复用，避免重复爬。
_SSE_UID_FILE = Path(__file__).resolve().parent.parent / ".cache" / "sse_uids.json"
_SSE_UID_MAP: Optional[dict[str, str]] = None


def _load_sse_uids() -> dict[str, str]:
    global _SSE_UID_MAP
    if _SSE_UID_MAP is None:
        try:
            _SSE_UID_MAP = json.loads(_SSE_UID_FILE.read_text("utf-8")) if _SSE_UID_FILE.exists() else {}
        except Exception:  # noqa: BLE001
            _SSE_UID_MAP = {}
    return _SSE_UID_MAP


def _save_sse_uids(m: dict[str, str]) -> None:
    global _SSE_UID_MAP
    _SSE_UID_MAP = m
    try:
        _SSE_UID_FILE.parent.mkdir(parents=True, exist_ok=True)
        _SSE_UID_FILE.write_text(json.dumps(m, ensure_ascii=False), "utf-8")
    except Exception:  # noqa: BLE001 - 缓存写失败不阻断
        pass


def _sse_build_uid_map() -> dict[str, str]:
    """爬 allcompany.do 全市场 code→uid 映射（72 页，直连+per-page 重试）。一次性。"""
    import requests
    from bs4 import BeautifulSoup

    m: dict[str, str] = {}
    with _no_proxy():
        for page in range(1, 73):
            try:
                r = _fetch_with_retry(
                    lambda p=page: requests.post(
                        "https://sns.sseinfo.com/allcompany.do",
                        data={"code": "0", "order": "2", "areaId": "0", "page": str(p)},
                        timeout=10,
                    )
                )
                j = r.json()
            except Exception:  # noqa: BLE001 - 单页失败（已重试）跳过，尽量凑齐
                continue
            soup = BeautifulSoup(j.get("content", ""), "lxml")
            for a in soup.find_all("a", attrs={"rel": "tag"}):
                uid = a.get("uid", "")
                img = a.find("img")
                code = img["src"].split("/")[-1].split(".")[0] if img else ""
                if uid and code:
                    m[code] = uid
            if not j.get("content"):
                break
    return m


def _sse_patched_uid_fetch() -> dict[str, str]:
    """猴补丁替换 akshare 的 _fetch_stock_uid：文件缓存优先，miss 则建一次全量映射。"""
    m = _load_sse_uids()
    if not m:
        m = _sse_build_uid_map()
        _save_sse_uids(m)
    return m


def _pick(columns, *cands: str) -> Optional[str]:
    """从列名里找首个包含任一候选子串的列（防 akshare 改列名）。"""
    for cand in cands:
        for col in columns:
            if cand in str(col):
                return col
    return None


def _cell(row, col) -> str:
    if not col:
        return ""
    val = row.get(col)
    s = "" if val is None else str(val).strip()
    return "" if s.lower() in ("nan", "nat", "none") else s


_DATE_RE = re.compile(
    r"(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}:\d{2}(?::\d{2})?))?"
)
_REL_DATE_RE = re.compile(r"(前天|昨天|今天)\s*(\d{1,2}:\d{2})?")


def _to_iso(val) -> str:
    """各种日期串 → 'YYYY-MM-DDTHH:MM:SS+08:00'；解析失败返回 ''。

    支持 YYYY-MM-DD / YYYY/M/D / **YYYY年M月D日**（sse_einteract 的中文格式），
    以及「昨天/今天/前天 HH:MM」相对日期（用本机今天回推）。
    """
    s = str(val)
    m = _DATE_RE.search(s)
    if m:
        y, mo, d, t = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4) or "00:00:00"
        if len(t) == 5:
            t += ":00"
        return f"{y}-{mo:02d}-{d:02d}T{t}+08:00"
    rm = _REL_DATE_RE.search(s)
    if rm:
        off = {"前天": 2, "昨天": 1, "今天": 0}[rm.group(1)]
        day = dt.date.today() - dt.timedelta(days=off)
        t = rm.group(2) or "00:00:00"
        if len(t) == 5:
            t += ":00"
        return f"{day.isoformat()}T{t}+08:00"
    return ""


def _cutoff(days: int) -> str:
    return (dt.date.today() - dt.timedelta(days=days)).isoformat()


class _AkInteractBase(BaseSource):
    """互动类源公共逻辑：取 DataFrame → 列自适应 → 过滤窗口 → map。"""

    authority = AUTHORITY_INTERACT
    _default_url = ""

    def _fetch_df(self, code: str, *, days: int = 30):
        raise NotImplementedError

    def search_company(
        self, code: str, name: str = "", *, days: int = 30
    ) -> list[DisclosureRecord]:
        df = self._fetch_df(code, days=days)
        if df is None or len(df) == 0:
            return []
        cols = list(df.columns)
        c_q = _pick(cols, "问题", "提问内容", "标题", "内容")
        c_a = _pick(cols, "回答内容", "回答", "答复")
        c_t = _pick(cols, "提问时间", "回答时间", "更新时间", "时间", "日期")
        c_name = _pick(cols, "公司简称", "股票简称", "简称", "公司名称")
        c_url = _pick(cols, "网址", "链接", "url", "URL")
        cutoff = _cutoff(days)
        out: list[DisclosureRecord] = []
        for _, row in df.iterrows():
            iso = _to_iso(_cell(row, c_t)) if c_t else ""
            if iso and iso[:10] < cutoff:
                continue
            q = _cell(row, c_q)
            a = _cell(row, c_a)
            # `||答复：` 分隔符是和 triage 的契约：triage._text() 对互动源只取答复正文做事实抽取
            # （见 Gap B），故答复必须放在该分隔符之后；改格式需同步 triage._ANSWER_SEP。
            excerpt = q + (f"  ||答复：{a}" if a else "")
            out.append(
                DisclosureRecord(
                    company_name=_cell(row, c_name) or name,
                    company_code=code,
                    source=self.name,
                    title=(q[:60] or "互动问答"),
                    url=_cell(row, c_url) or self._default_url,
                    published_at=iso,
                    summary=q[:140],
                    raw_excerpt=excerpt[:500],
                    matched_keywords=[],
                    source_authority=AUTHORITY_INTERACT,
                )
            )
        return out

    def search_keyword(
        self, keyword: str, *, days: int = 30, codes: Optional[list[str]] = None
    ) -> list[DisclosureRecord]:
        # 互动类无全局关键词检索：须给 codes，逐家查后本地过滤 keyword。
        if not codes:
            return []
        out: list[DisclosureRecord] = []
        for code in codes:
            for r in self.search_company(code, days=days):
                if keyword in r.raw_excerpt or keyword in r.title:
                    if keyword not in r.matched_keywords:
                        r.matched_keywords.append(keyword)
                    out.append(r)
        return out


class IrmSource(_AkInteractBase):
    """深交所互动易（巨潮 irm）。"""

    name = "irm_szse"
    _default_url = "https://irm.cninfo.com.cn/"

    def _fetch_df(self, code: str, *, days: int = 30):
        with _no_proxy():  # 国内源直连，绕开 VPN 系统代理
            return _fetch_with_retry(lambda: _akshare().stock_irm_cninfo(symbol=code))


class SseEInteractSource(_AkInteractBase):
    """上证 e 互动。"""

    name = "sse_einteract"
    _default_url = "https://sns.sseinfo.com/"

    def _fetch_df(self, code: str, *, days: int = 30):
        ak = _akshare()
        # 猴补丁 _fetch_stock_uid：用文件缓存的全量映射，避免每次都爬 72 页 allcompany.do
        sse_mod = inspect.getmodule(ak.stock_sns_sseinfo)
        if sse_mod is not None and hasattr(sse_mod, "_fetch_stock_uid"):
            sse_mod._fetch_stock_uid = _sse_patched_uid_fetch
        with _no_proxy():  # 国内源直连，绕开 VPN 系统代理（sse 抖动根因）
            return _fetch_with_retry(lambda: ak.stock_sns_sseinfo(symbol=code))
