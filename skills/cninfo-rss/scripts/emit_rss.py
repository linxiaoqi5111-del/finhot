#!/usr/bin/env python3
"""归一化记录 → Atom 1.0 feed。

为什么 Atom 不是 RSS 2.0：Atom（RFC 4287）日期字段强制 RFC3339/ISO8601，且
<id> 语义清晰（用 announcement_id 做稳定去重键），比 RSS2.0 的 <guid>/<pubDate>
(RFC822) 更适合机器消费。两者主流阅读器都支持，这里优先 Atom。

只用标准库 xml.sax.saxutils 做转义，不引第三方，保证 macOS 自带 python 可跑。
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from xml.sax.saxutils import escape

ATOM_NS = "http://www.w3.org/2005/Atom"


def _esc(text: str) -> str:
    return escape(text or "")


def _entry_xml(rec: dict) -> str:
    sec_name = rec.get("sec_name", "")
    sec_code = rec.get("sec_code", "")
    title = rec.get("title", "")
    ann_id = rec.get("announcement_id", "")
    published = rec.get("published_at", "")
    detail_url = rec.get("detail_url", "")
    summary_lines = [
        f"PDF: {rec.get('pdf_url', '')}",
        f"category: {rec.get('category_code') or rec.get('announcement_type') or '-'}",
        f"fact_type: {rec.get('fact_type', '-')}",
        f"update_type: {rec.get('update_type', '-')}",
        f"confidence: {rec.get('confidence', '-')}",
        f"match: {rec.get('l3_match_reason', '-')}",
    ]
    summary = "\n".join(summary_lines)
    return (
        "  <entry>\n"
        f"    <title>{_esc(f'{sec_name}({sec_code}): {title}')}</title>\n"
        f"    <id>urn:cninfo:announcement:{_esc(ann_id)}</id>\n"
        f"    <published>{_esc(published)}</published>\n"
        f"    <updated>{_esc(published)}</updated>\n"
        f'    <link rel="alternate" href="{_esc(detail_url)}"/>\n'
        f'    <category term="{_esc(rec.get("fact_type", ""))}"/>\n'
        f"    <summary>{_esc(summary)}</summary>\n"
        "  </entry>\n"
    )


def build_atom(feed_id: str, title: str, records: Iterable[dict], *, self_path: str = "") -> str:
    records = list(records)
    now_iso = datetime.now(timezone.utc).astimezone().isoformat()
    updated = records[0].get("published_at") if records else now_iso
    parts = [
        '<?xml version="1.0" encoding="utf-8"?>\n',
        f'<feed xmlns="{ATOM_NS}">\n',
        f"  <title>{_esc(title)}</title>\n",
        f"  <id>urn:cninfo-rss:{_esc(feed_id)}</id>\n",
        f"  <updated>{_esc(updated)}</updated>\n",
        '  <generator>cninfo-rss</generator>\n',
    ]
    if self_path:
        parts.append(f'  <link rel="self" href="{_esc(self_path)}"/>\n')
    for rec in records:
        parts.append(_entry_xml(rec))
    parts.append("</feed>\n")
    return "".join(parts)


def write_feeds(records: list[dict], rss_dir: Path, config: dict) -> dict:
    """写出三类 feed，返回 {path: count} 概览。"""
    rss_dir = Path(rss_dir)
    (rss_dir / "by-category").mkdir(parents=True, exist_ok=True)
    written: dict[str, int] = {}

    # 0) 清理历史改名遗留的陈旧 feed：否则订阅端不会 404，而会「静默读旧数据」。
    for stale in ("l3-hard-delta.xml",):
        sp = rss_dir / stale
        if sp.exists():
            sp.unlink()

    # 1) 全市场 L3 候选 · 高确定性合集（仅 hard_delta）
    # 命名刻意叫「候选」而非「硬事实」：本 skill 只读标题+元数据、未解析正文，
    # 按 KB 口径只能产 L1_L3_candidate，不能误导为已验证的 L3 hard_fact。
    hard = [r for r in records if r.get("update_type") == "hard_delta"]
    p = rss_dir / "l3-candidates-hard-delta.xml"
    p.write_text(
        build_atom("l3-candidates-hard-delta", "巨潮 L3 候选 · 高确定性公告", hard),
        encoding="utf-8",
    )
    written[str(p)] = len(hard)

    # 2) 按分类（hard + review 都进各自分类）
    cat_names = {c["code"]: c.get("name", c["code"]) for c in (config.get("l3_categories") or [])}
    by_cat: dict[str, list[dict]] = {}
    for r in records:
        code = r.get("category_code")
        if code:
            by_cat.setdefault(code, []).append(r)
    for code, recs in by_cat.items():
        p = rss_dir / "by-category" / f"{code}.xml"
        title = f"巨潮 L3 · {cat_names.get(code, code)}"
        p.write_text(build_atom(code, title, recs), encoding="utf-8")
        written[str(p)] = len(recs)

    # 3) 自选股（watchlist_codes；为空时镜像全部）
    watchlist = [str(c).strip() for c in (config.get("watchlist_codes") or [])]
    if watchlist:
        wl = [r for r in records if r.get("sec_code") in watchlist]
    else:
        wl = list(records)
    p = rss_dir / "watchlist.xml"
    p.write_text(build_atom("watchlist", "巨潮 L3 · 自选股", wl), encoding="utf-8")
    written[str(p)] = len(wl)

    return written


if __name__ == "__main__":
    sample = [
        {
            "announcement_id": "1225398031",
            "sec_code": "688689",
            "sec_name": "银河微电",
            "title": "股权激励计划草案",
            "published_at": "2026-06-30T08:00:00+08:00",
            "pdf_url": "http://static.cninfo.com.cn/finalpage/2026-06-30/1225398031.PDF",
            "detail_url": "https://www.cninfo.com.cn/new/disclosure/detail?stockCode=688689&announcementId=1225398031",
            "category_code": "category_gqjl_szsh",
            "fact_type": "equity_incentive",
            "update_type": "hard_delta",
            "confidence": "high",
            "l3_match_reason": "category:股权激励",
        }
    ]
    print(build_atom("demo", "demo", sample))
