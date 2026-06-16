"""规则简报：从热榜 feed（feed.build_hot_feed 的输出）按固定规则生成一份
人读的当日简报。纯规则、无模型——把"什么值得看"的判断显式编码成阈值与标签：

  · 突发  lift ≥ LIFT_BURST            → 标 `突发×N`
  · 新词  is_new                       → 标 `NEW`
  · 高浓度 spec_ratio ≥ HOT_SPEC_RATIO  → 产业词标 `高浓度`（强 A股炒作语境）

build_brief(feed) 返回结构化 dict（lead 导语 + 三段 sections，每条带 tags 与渲染好的
one-liner），render_markdown(brief) 把它渲染成 Markdown。两者分离便于下游既能拿结构化
数据自动播报，也能直接取 Markdown 文本。
"""
from . import board, feed

LIFT_BURST = 3.0        # 突发倍数阈值
HOT_SPEC_RATIO = 0.6    # 产业词"高浓度"阈值

_BOARD_TITLES = {"industry": "产业题材", "event": "催化事件", "entity": "实体异动"}
_BOARD_ICONS = {"industry": "📈", "event": "⚡", "entity": "🏢"}
_BOARD_TOPN = {"industry": 8, "event": 5, "entity": 5}


def _tags(item, board_name):
    tags = []
    if item.get("is_new"):
        tags.append("NEW")
    if item.get("lift", 0) >= LIFT_BURST:
        tags.append(f"突发×{item['lift']}")
    if board_name == "industry" and item.get("spec_ratio", 0) >= HOT_SPEC_RATIO:
        tags.append("高浓度")
    return tags


def _line(item, board_name, tags):
    term = item["term"]
    pct = round(item.get("spec_ratio", 0) * 100)
    tag_str = ("  " + " · ".join(f"`{t}`" for t in tags)) if tags else ""
    if board_name == "industry":
        body = f"**{term}** 热度 {item['score']} · 突发 ×{item['lift']} · 炒作 {pct}% · {item['today']} 条"
    elif board_name == "event":
        body = f"**{term}** 突发 ×{item['lift']} · {item['today']} 条"
    else:  # entity
        themes = " / ".join(item.get("themes") or []) or "—"
        body = f"**{term}** → {themes} · {item['today']} 条"
    return body + tag_str


def _lead(sections_by_board):
    ind = sections_by_board.get("industry") or []
    ev = sections_by_board.get("event") or []
    if not ind and not ev:
        return "今日无显著热点（数据可能尚未采集，或当日条目过少）。"
    parts = []
    if ind:
        top = ind[0]
        parts.append(
            f"产业题材以「{top['term']}」领涨（突发 ×{top['lift']}，炒作浓度 {round(top['spec_ratio'] * 100)}%）"
        )
    if ev:
        parts.append(f"催化事件关注「{ev[0]['term']}」")
    return "；".join(parts) + "。"


def build_brief(feed_data, *, topn=None):
    """feed dict -> 结构化简报 dict（lead + sections）。topn 可覆盖各榜条数。"""
    topn = {**_BOARD_TOPN, **(topn or {})}
    boards = feed_data.get("boards", {})
    sections = []
    sliced = {}
    for b in board.BOARDS:
        items = (boards.get(b) or [])[: topn.get(b, 5)]
        sliced[b] = items
        out_items = []
        for it in items:
            tags = _tags(it, b)
            out_items.append({
                "term": it["term"],
                "type": it.get("type"),
                "themes": it.get("themes") or [],
                "today": it.get("today"),
                "score": it.get("score"),
                "lift": it.get("lift"),
                "spec_ratio": it.get("spec_ratio"),
                "is_new": it.get("is_new", False),
                "tags": tags,
                "line": _line(it, b, tags),
            })
        sections.append({"board": b, "title": _BOARD_TITLES[b], "icon": _BOARD_ICONS[b], "items": out_items})
    return {
        "day": feed_data.get("day"),
        "generated_at": feed_data.get("generated_at"),
        "total_items": feed_data.get("total_items"),
        "baseline": feed_data.get("baseline"),
        "gate": feed_data.get("gate"),
        "lead": _lead(sliced),
        "sections": sections,
    }


def render_markdown(brief):
    """结构化简报 -> Markdown 文本。"""
    gate_txt = "开" if brief.get("gate") else "关"
    lines = [
        f"# 🔥 FinHot 简报 · {brief.get('day') or '—'}",
        "",
        f"> 当日快讯 {brief.get('total_items', 0)} 条 · 基线 {brief.get('baseline')} 天 · A股炒作闸口 {gate_txt}",
        "",
        f"**今日要点**：{brief.get('lead', '')}",
    ]
    for sec in brief.get("sections", []):
        items = sec["items"]
        lines.append("")
        lines.append(f"## {sec['icon']} {sec['title']}")
        if not items:
            lines.append("")
            lines.append("_暂无_")
            continue
        lines.append("")
        for i, it in enumerate(items, 1):
            lines.append(f"{i}. {it['line']}")
    lines.append("")
    return "\n".join(lines)


def build_brief_from_db(conn, **feed_kwargs):
    """便捷入口：连库 -> 建 feed -> 出简报 dict。"""
    feed_data = feed.build_hot_feed(conn, **feed_kwargs)
    return build_brief(feed_data)


def main():
    """CLI：打印当日 Markdown 简报到 stdout（便于 cron/自动播报）。"""
    from . import db
    conn = db.connect()
    brief = build_brief_from_db(conn)
    conn.close()
    print(render_markdown(brief))


if __name__ == "__main__":
    main()
