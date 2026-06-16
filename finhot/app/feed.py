"""机器可读热榜 feed：把三榜（产业/事件/实体）合成一个结构化 JSON，
供 /feed/hot.json 端点、规则简报（brief.py）与外部下游（自动播报/聚合）消费。

复用 board.compute_board，保证 feed 与看板 /api/hotwords 同源同算法，不分叉。
"""
import time

from . import board


def build_hot_feed(conn, *, day="", baseline=7, limit=30, gate=1,
                   min_spec_ratio=0.4, boards=board.BOARDS):
    """返回三榜合一的 feed dict：

    {
      "generated_at": <unix秒>,         # 生成时刻
      "day": "2026-06-16",              # 数据归属日（空 day 时取库内最新一天）
      "total_items": 803,               # 当日入库条数
      "baseline": 7, "gate": 1,         # 计算参数回显
      "boards": {"industry": [...], "event": [...], "entity": [...]}
    }
    """
    day = board.resolve_day(conn, day)
    out_boards = {}
    total_items = 0
    for b in boards:
        res = board.compute_board(
            conn, day=day, baseline=baseline, limit=limit,
            gate=gate, min_spec_ratio=min_spec_ratio, board=b,
        )
        total_items = res["total_items"]
        out_boards[b] = res["hotwords"]
    return {
        "generated_at": int(time.time()),
        "day": day,
        "total_items": total_items,
        "baseline": baseline,
        "gate": gate,
        "min_spec_ratio": min_spec_ratio,
        "boards": out_boards,
    }
