#!/usr/bin/env python3
"""巨潮(cninfo)公告抓取 + 过滤 + 归一化。

设计取舍（教学备注）：
- 只用标准库 urllib，不引 requests —— 这个 skill 要能在 macOS 自带 python3.9
  上零依赖运行（仅 config 解析用 PyYAML）。requests 更顺手但多一个依赖。
- 主路径直连巨潮 hisAnnouncement/query（POST x-www-form-urlencoded），不依赖
  公共 RSSHub（rsshub.app 常 403/503）或本机 RSSHub（无 cninfo 路由）。
- 两条抓取路径：
    1) 分类码路径：category=<code>，巨潮官方分类，命中即 L3 候选。
    2) 关键词路径：searchkey=<kw>，服务端按标题检索，命中 include_any 即候选。
  关键词路径用 searchkey 让巨潮帮我们缩小范围，避免拉全市场上万条再本地过滤。
- column 字段在该接口实测不按市场过滤，故市场过滤改用 code 前缀本地判定。
"""
from __future__ import annotations

import json
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import yaml

CN_TZ = timezone(timedelta(hours=8))
QUERY_URL = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
STATIC_BASE = "http://static.cninfo.com.cn/"
DETAIL_BASE = "https://www.cninfo.com.cn/new/disclosure/detail?annoId="
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

REPO_ROOT = Path(__file__).resolve().parents[3]


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #
def ts_to_iso(ts: Any) -> str:
    """巨潮 announcementTime 为 Unix 毫秒整数 → ISO8601(+08:00)。

    例：1782748800000 → '2026-06-30T00:00:00+08:00'。
    RSS 输出禁止原样吐毫秒字符串，必须经过这里。
    """
    if ts is None or ts == "":
        return ""
    if isinstance(ts, str):
        ts = ts.strip()
        if not ts.isdigit():
            return ts  # 已是字符串日期，原样返回
        ts = int(ts)
    if isinstance(ts, (int, float)):
        # 毫秒 → 秒。>1e12 视为毫秒。
        seconds = ts / 1000 if ts > 1_000_000_000_000 else float(ts)
        return datetime.fromtimestamp(seconds, CN_TZ).isoformat()
    return str(ts)


def market_of_code(code: str) -> str:
    """按 A 股代码前缀判定市场。"""
    code = (code or "").strip()
    if code.startswith("6"):
        return "sse"
    if code.startswith(("0", "3")):
        return "szse"
    if code.startswith(("8", "4")):
        return "bj"
    return "unknown"


def org_id_of_code(code: str) -> str:
    """构造巨潮 stock 参数所需 orgId（自选股精确查询用）。"""
    if code.startswith("6"):
        return f"gssh0{code}"
    if code.startswith(("8", "4")):
        return f"gsbj0{code}"
    return f"gssz0{code}"


_EM_RE = re.compile(r"</?em>", re.IGNORECASE)
_WS_RE = re.compile(r"\s+")


def clean_title(title: str) -> str:
    """去掉 isHLtitle 高亮 <em> 标签并压缩空白。"""
    if not title:
        return ""
    return _WS_RE.sub(" ", _EM_RE.sub("", title)).strip()


def slugify(text: str, maxlen: int = 40) -> str:
    """生成文件名安全 slug（保留中英文数字，其余转下划线）。"""
    text = clean_title(text)
    text = re.sub(r"[^\w\u4e00-\u9fff]+", "_", text)
    return text.strip("_")[:maxlen] or "untitled"


def load_config(path: str | Path | None = None) -> dict:
    cfg_path = Path(path) if path else (Path(__file__).resolve().parents[1] / "config.yaml")
    with open(cfg_path, "r", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def resolve_path(p: str, base: Path = REPO_ROOT) -> Path:
    """相对路径相对仓库根解析；绝对路径原样。"""
    pp = Path(p)
    return pp if pp.is_absolute() else (base / pp)


# --------------------------------------------------------------------------- #
# 巨潮客户端
# --------------------------------------------------------------------------- #
class CninfoClient:
    def __init__(self, rate_limit_seconds: float = 2.0, timeout: int = 20):
        self.rate_limit_seconds = rate_limit_seconds
        self.timeout = timeout
        self._last_call = 0.0

    def _throttle(self) -> None:
        wait = self.rate_limit_seconds - (time.time() - self._last_call)
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.time()

    def query_page(
        self,
        *,
        se_date: str,
        page_num: int = 1,
        page_size: int = 50,
        category: str = "",
        searchkey: str = "",
        stock: str = "",
        column: str = "szse",
    ) -> dict:
        payload = {
            "pageNum": str(page_num),
            "pageSize": str(page_size),
            "column": column,
            "tabName": "fulltext",
            "plate": "",
            "stock": stock,
            "searchkey": searchkey,
            "secid": "",
            "category": category,
            "trade": "",
            "seDate": se_date,
            "sortName": "",
            "sortType": "",
            "isHLtitle": "false",
        }
        data = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(
            QUERY_URL,
            data=data,
            headers={
                "User-Agent": UA,
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": "https://www.cninfo.com.cn/new/disclosure",
                "Origin": "https://www.cninfo.com.cn",
                "Accept": "application/json, text/plain, */*",
            },
            method="POST",
        )
        self._throttle()
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))

    def iter_announcements(
        self, *, max_pages: int, page_size: int, **page_kwargs
    ) -> Iterable[dict]:
        for page_num in range(1, max_pages + 1):
            try:
                d = self.query_page(page_num=page_num, page_size=page_size, **page_kwargs)
            except Exception as exc:  # noqa: BLE001 - 网络波动不应中断整批
                print(f"[fetch] query failed page={page_num} {page_kwargs}: {exc}")
                break
            anns = d.get("announcements") or []
            for item in anns:
                yield item
            if not d.get("hasMore"):
                break


# --------------------------------------------------------------------------- #
# 归一化 + 分类
# --------------------------------------------------------------------------- #
def normalize_raw(item: dict) -> dict:
    """巨潮原始条目 → 中间归一化记录（未分类）。"""
    code = (item.get("secCode") or "").strip()
    ann_id = str(item.get("announcementId") or "").strip()
    adj = item.get("adjunctUrl") or ""
    pdf_url = (STATIC_BASE + adj) if adj else ""
    return {
        "announcement_id": ann_id,
        "sec_code": code,
        "sec_name": clean_title(item.get("secName") or ""),
        "title": clean_title(item.get("announcementTitle") or ""),
        "announcement_type": (item.get("announcementTypeName") or "").strip(),
        "category_code": "",
        "published_at": ts_to_iso(item.get("announcementTime")),
        "published_ms": item.get("announcementTime"),
        "pdf_url": pdf_url,
        "detail_url": f"{DETAIL_BASE}{ann_id}" if ann_id else "",
        "market": market_of_code(code),
    }


def _contains_any(text: str, words: Iterable[str]) -> str | None:
    for w in words:
        if w and w in text:
            return w
    return None


def classify(record: dict, config: dict) -> dict | None:
    """对一条归一化记录做 L3 判定。

    返回补全了 evidence_layer/update_type/fact_type/confidence/... 的记录；
    若命中 exclude_any 或不构成 L3 候选则返回 None。

    优先级：exclude_any（丢弃）> 分类码命中 > 关键词命中 > 不命中（None）。
    """
    title = record.get("title", "")
    kw = config.get("l3_title_keywords", {}) or {}

    # 1) 噪音直接丢弃（最高优先级）
    if _contains_any(title, kw.get("exclude_any", []) or []):
        return None

    # 2) 判定命中来源
    fact_type = None
    reason = None

    # 分类码路径（category_code 在 collect 阶段已写入）
    cat_code = record.get("category_code") or ""
    cat_map = {c["code"]: c for c in (config.get("l3_categories") or []) if c.get("enabled", True)}
    if cat_code and cat_code in cat_map:
        cat = cat_map[cat_code]
        fts = cat.get("fact_types") or []
        fact_type = fts[0] if fts else config.get("default_fact_type", "other_hard")
        reason = f"category:{cat.get('name', cat_code)}"

    # 关键词路径（标题命中 include_any）
    if reason is None:
        hit = _contains_any(title, kw.get("include_any", []) or [])
        if hit:
            ft_map = config.get("fact_type_by_keyword", {}) or {}
            fact_type = ft_map.get(hit, config.get("default_fact_type", "other_hard"))
            reason = f"keyword:{hit}"

    if reason is None:
        return None  # 不构成 L3 候选

    # 3) 低确定性降级
    low_hit = _contains_any(title, config.get("low_confidence_keywords", []) or [])
    if low_hit:
        update_type = "review_candidate"
        confidence = "low"
        fact_status = "planned"
        reason = f"{reason}|low:{low_hit}"
    else:
        update_type = "hard_delta"
        confidence = "high"
        fact_status = "realized"

    out = dict(record)
    out.update(
        {
            "l3_match_reason": reason,
            "evidence_layer": "L3",
            "update_type": update_type,
            "fact_type": fact_type,
            "confidence": confidence,
            "fact_status": fact_status,
        }
    )
    return out


def _market_allowed(record: dict, markets: list[str]) -> bool:
    return (not markets) or record.get("market") in markets


def collect(config: dict, client: CninfoClient | None = None) -> list[dict]:
    """按 config 抓取 + 归一化 + 分类 + 市场/自选股过滤，返回去重后的 L3 候选列表。"""
    client = client or CninfoClient(rate_limit_seconds=float(config.get("rate_limit_seconds", 2)))
    lookback = int(config.get("lookback_days", 7))
    today = datetime.now(CN_TZ).date()
    se_date = f"{today - timedelta(days=lookback)}~{today}"
    page_size = int(config.get("page_size", 50))
    max_pages = int(config.get("max_pages_per_source", 5))
    markets = config.get("markets", []) or []
    watchlist = [str(c).strip() for c in (config.get("watchlist_codes") or [])]

    raw_by_id: dict[str, dict] = {}

    def _ingest(item: dict, category_code: str) -> None:
        rec = normalize_raw(item)
        if not rec["announcement_id"]:
            return
        if category_code:
            # 首次见到（分类路径）才覆盖 category_code，避免关键词路径清掉它
            rec["category_code"] = category_code
        prev = raw_by_id.get(rec["announcement_id"])
        if prev is None:
            raw_by_id[rec["announcement_id"]] = rec
        elif category_code and not prev.get("category_code"):
            prev["category_code"] = category_code

    if watchlist:
        # 自选股路径：按 code 精确查询（高效），分类/关键词在本地判定
        for code in watchlist:
            stock = f"{code},{org_id_of_code(code)}"
            for item in client.iter_announcements(
                max_pages=max_pages, page_size=page_size, se_date=se_date, stock=stock
            ):
                _ingest(item, "")
    else:
        # 全市场路径：分类码 + 关键词 searchkey
        for cat in config.get("l3_categories") or []:
            if not cat.get("enabled", True):
                continue
            for item in client.iter_announcements(
                max_pages=max_pages, page_size=page_size, se_date=se_date, category=cat["code"]
            ):
                _ingest(item, cat["code"])
        for kw in (config.get("l3_title_keywords", {}) or {}).get("include_any", []) or []:
            for item in client.iter_announcements(
                max_pages=max_pages, page_size=page_size, se_date=se_date, searchkey=kw
            ):
                _ingest(item, "")

    results: list[dict] = []
    for rec in raw_by_id.values():
        if watchlist and rec["sec_code"] not in watchlist:
            continue
        if not _market_allowed(rec, markets):
            continue
        classified = classify(rec, config)
        if classified is not None:
            results.append(classified)

    # 按发布时间倒序
    results.sort(key=lambda r: r.get("published_ms") or 0, reverse=True)
    return results


if __name__ == "__main__":  # 快速冒烟
    cfg = load_config()
    cfg["max_pages_per_source"] = 1
    recs = collect(cfg)
    print(f"collected={len(recs)}")
    for r in recs[:10]:
        print(" ", r["published_at"], r["sec_name"], r["sec_code"], "|", r["update_type"], r["fact_type"], "|", r["title"][:36])
