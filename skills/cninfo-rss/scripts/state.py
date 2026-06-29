#!/usr/bin/env python3
"""增量去重水位（state.json）。

去重键用 announcement_id（巨潮全局唯一、稳定），比用 url/标题更可靠。
另存 high_water_ms（已见公告的最大 announcementTime），便于排查与未来按时间增量。

取舍：这里用「已见 id 集合」做精确去重（实现简单、跨天可靠）。海量场景可改为
仅存水位时间戳 + 边界去重以省空间，但 id 集合对单机日级数据量完全够用。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

_MAX_SEEN = 50000  # 防止 seen_ids 无限膨胀，仅保留最近 N 个


def load_state(path: str | Path) -> dict:
    p = Path(path)
    if not p.exists():
        return {"seen_ids": [], "high_water_ms": 0, "updated_at": None}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"seen_ids": [], "high_water_ms": 0, "updated_at": None}
    data.setdefault("seen_ids", [])
    data.setdefault("high_water_ms", 0)
    return data


def filter_new(records: list[dict], state: dict) -> list[dict]:
    """剔除 announcement_id 已在 state 中出现过的记录。"""
    seen = set(state.get("seen_ids", []))
    return [r for r in records if r.get("announcement_id") not in seen]


def update_state(state: dict, records: list[dict]) -> dict:
    """把本批记录的 id 并入 seen_ids，并推进 high_water_ms。"""
    seen = list(dict.fromkeys(state.get("seen_ids", [])))  # 去重保序
    existing = set(seen)
    high = int(state.get("high_water_ms", 0) or 0)
    for r in records:
        aid = r.get("announcement_id")
        if aid and aid not in existing:
            seen.append(aid)
            existing.add(aid)
        ms = r.get("published_ms") or 0
        if isinstance(ms, (int, float)) and ms > high:
            high = int(ms)
    if len(seen) > _MAX_SEEN:
        seen = seen[-_MAX_SEEN:]
    state["seen_ids"] = seen
    state["high_water_ms"] = high
    state["updated_at"] = datetime.now(timezone.utc).astimezone().isoformat()
    return state


def save_state(path: str | Path, state: dict) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
