#!/usr/bin/env python3
"""把 L3 候选归档到 knowledge-base-private/wiki/raw/disclosures/。

对齐 skills/disclosure-archive 的「只归档不入库」安全边界：
- update_type=hard_delta 且 confidence=high → 写归档 markdown + manifest.jsonl
  + review-queue（人工待审）。
- update_type=review_candidate → 只写 manifest.jsonl，不进 review-queue 自动 apply。
- 任何情况都不碰 wiki/entities/ 、concepts/ 、relations/ 、evidence_index。

archive_id 规则：disc-cninfo-YYYYMMDD-NNNN（按 publish_date 当日递增）。
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

CN_NOW = lambda: datetime.now(timezone(__import__("datetime").timedelta(hours=8)))  # noqa: E731

# 归档 markdown frontmatter 字段顺序（与 disclosure-archive 对齐）
_FM_ORDER = [
    "archive_id", "theme_term", "canonical_concept", "company", "code",
    "chain_layer", "role", "exposure_strength", "evidence_layer", "update_type",
    "fact_type", "source_type", "source_origin", "fact_status", "confidence",
    "evidence_polarity", "time_scope", "fact_traceability", "publish_date",
    "url", "pdf_url", "announcement_id", "l3_match_reason", "source",
    "fetched_at", "ingest_status", "review_status", "not_applied",
    "quoted_text", "extracted_facts",
]


def _fm_value(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, list):
        return json.dumps(v, ensure_ascii=False)
    return json.dumps(str(v), ensure_ascii=False)  # 带引号、转义安全


def _build_markdown(fm: dict, rec: dict) -> str:
    lines = ["---"]
    for k in _FM_ORDER:
        if k in fm:
            lines.append(f"{k}: {_fm_value(fm[k])}")
    lines.append("---")
    body = [
        f"# {fm['company']}({fm['code']}): {rec['title']}",
        "",
        "## 来源",
        f"- 公司：{fm['company']}（{fm['code']}）",
        f"- 分类：{rec.get('category_code') or rec.get('announcement_type') or '-'}",
        f"- 匹配原因：{rec.get('l3_match_reason', '-')}",
        f"- 详情页：{rec.get('detail_url', '')}",
        f"- PDF：{rec.get('pdf_url', '')}",
        f"- 发布日期：{fm['publish_date']}",
        "",
        "## 标题（quoted_text）",
        rec["title"],
        "",
        "> 仅归档官方公告元数据，未解析 PDF 全文；如需正文事实请走 disclosure-archive 人工/OCR。",
        "",
    ]
    return "\n".join(lines) + "\n\n" + "\n".join(body)


def _next_index(manifest_path: Path, ymd: str, used: set[int]) -> int:
    prefix = f"disc-cninfo-{ymd}-"
    mx = 0
    if manifest_path.exists():
        for line in manifest_path.read_text(encoding="utf-8").splitlines():
            m = re.search(rf"{re.escape(prefix)}(\d+)", line)
            if m:
                mx = max(mx, int(m.group(1)))
    n = mx + 1
    while n in used:
        n += 1
    used.add(n)
    return n


def archive_records(records: list[dict], kb_dir: Path, batch_id: str, *, apply: bool) -> dict:
    """归档。apply=False 时只统计不落盘（dry-run）。返回统计字典。"""
    kb_dir = Path(kb_dir)
    manifest_path = kb_dir / "manifest.jsonl"
    review_queue_path = kb_dir / "review-queue" / f"cninfo-rss-{batch_id}.json"
    fetched_at = CN_NOW().isoformat()

    stats = {"archived_md": 0, "manifest_lines": 0, "review_queue": 0}
    manifest_lines: list[str] = []
    review_entries: list[dict] = []
    used_idx: dict[str, set[int]] = {}

    for rec in records:
        publish_date = (rec.get("published_at") or "")[:10] or CN_NOW().strftime("%Y-%m-%d")
        ymd = publish_date.replace("-", "")
        is_hard = rec.get("update_type") == "hard_delta" and rec.get("confidence") == "high"

        idx = _next_index(manifest_path, ymd, used_idx.setdefault(ymd, set()))
        archive_id = f"disc-cninfo-{ymd}-{idx:04d}"

        markdown_rel = None
        if is_hard:
            slug = re.sub(r"[^\w\u4e00-\u9fff]+", "_", rec["title"]).strip("_")[:40] or "untitled"
            fname = f"cninfo_{rec['sec_code']}_{rec['announcement_id']}_{slug}.md"
            markdown_rel = f"{publish_date}/{fname}"
            fm = {
                "archive_id": archive_id, "theme_term": "", "canonical_concept": "",
                "company": rec["sec_name"], "code": rec["sec_code"],
                "chain_layer": "", "role": "", "exposure_strength": "related",
                "evidence_layer": "L3", "update_type": rec["update_type"],
                "fact_type": rec.get("fact_type", "other_hard"),
                "source_type": "announcement", "source_origin": "primary_official",
                "fact_status": rec.get("fact_status", "realized"),
                "confidence": rec.get("confidence", "high"),
                "evidence_polarity": "neutral", "time_scope": "current",
                "fact_traceability": "all_facts_supported", "publish_date": publish_date,
                "url": rec.get("detail_url", ""), "pdf_url": rec.get("pdf_url", ""),
                "announcement_id": rec["announcement_id"],
                "l3_match_reason": rec.get("l3_match_reason", ""), "source": "cninfo-rss",
                "fetched_at": fetched_at, "ingest_status": "archived_only",
                "review_status": "unreviewed", "not_applied": True,
                "quoted_text": rec["title"], "extracted_facts": [rec["title"]],
            }
            if apply:
                day_dir = kb_dir / publish_date
                day_dir.mkdir(parents=True, exist_ok=True)
                (day_dir / fname).write_text(_build_markdown(fm, rec), encoding="utf-8")
            stats["archived_md"] += 1
            review_entries.append({
                "archive_id": archive_id, "code": rec["sec_code"], "company": rec["sec_name"],
                "title": rec["title"], "markdown_path": markdown_rel,
                "fact_type": rec.get("fact_type"), "review_action": "pending",
            })

        manifest_lines.append(json.dumps({
            "archive_id": archive_id, "batch_id": batch_id, "theme_term": "",
            "company": rec["sec_name"], "code": rec["sec_code"],
            "source_type": "announcement", "title": rec["title"],
            "publish_date": publish_date, "evidence_layer": "L3",
            "update_type": rec["update_type"], "markdown_path": markdown_rel,
            "ingest_status": "archived_only", "review_status": "unreviewed",
            "fact_type": rec.get("fact_type"), "source_origin": "primary_official",
            "fact_status": rec.get("fact_status"), "confidence": rec.get("confidence"),
            "source": "cninfo-rss", "announcement_id": rec["announcement_id"],
            "detail_url": rec.get("detail_url", ""),
            "l3_match_reason": rec.get("l3_match_reason", ""),
        }, ensure_ascii=False))

    stats["manifest_lines"] = len(manifest_lines)
    stats["review_queue"] = len(review_entries)

    if apply:
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        with open(manifest_path, "a", encoding="utf-8") as fh:
            for line in manifest_lines:
                fh.write(line + "\n")
        if review_entries:
            review_queue_path.parent.mkdir(parents=True, exist_ok=True)
            existing = []
            if review_queue_path.exists():
                try:
                    existing = json.loads(review_queue_path.read_text(encoding="utf-8")).get("items", [])
                except (json.JSONDecodeError, OSError):
                    existing = []
            payload = {
                "batch_id": batch_id, "source": "cninfo-rss",
                "generated_at": fetched_at, "items": existing + review_entries,
            }
            review_queue_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    return stats
