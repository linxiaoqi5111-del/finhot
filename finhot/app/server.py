"""FinHot API + 静态前端。

运行: uvicorn app.server:app --host 0.0.0.0 --port 8000
"""
import datetime
import os

from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import board, brief, db, feed
from .events import source_tier

app = FastAPI(title="FinHot 金融热词监控")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "web")


@app.get("/api/hotwords")
def hotwords(
    day: str = "",
    baseline: int = Query(7, ge=1, le=30),
    limit: int = Query(50, ge=1, le=200),
    gate: int = Query(1, ge=0, le=1),
    min_spec_ratio: float = Query(0.4, ge=0.0, le=1.0),
    board_name: str = Query("industry", alias="board", pattern="^(industry|event|entity)$"),
):
    conn = db.connect()
    result = board.compute_board(
        conn, day=day, baseline=baseline, limit=limit,
        gate=gate, min_spec_ratio=min_spec_ratio, board=board_name,
    )
    conn.close()
    return result


@app.get("/feed/hot.json")
def feed_hot(
    day: str = "",
    baseline: int = Query(7, ge=1, le=30),
    limit: int = Query(30, ge=1, le=200),
    gate: int = Query(1, ge=0, le=1),
    min_spec_ratio: float = Query(0.4, ge=0.0, le=1.0),
):
    """机器可读热榜 feed：三榜合一，供下游聚合/播报消费。"""
    conn = db.connect()
    data = feed.build_hot_feed(
        conn, day=day, baseline=baseline, limit=limit,
        gate=gate, min_spec_ratio=min_spec_ratio,
    )
    conn.close()
    return data


def _build_brief(day, baseline, gate, min_spec_ratio):
    conn = db.connect()
    feed_data = feed.build_hot_feed(
        conn, day=day, baseline=baseline, gate=gate, min_spec_ratio=min_spec_ratio,
    )
    conn.close()
    return brief.build_brief(feed_data)


@app.get("/feed/brief.json")
def feed_brief_json(
    day: str = "",
    baseline: int = Query(7, ge=1, le=30),
    gate: int = Query(1, ge=0, le=1),
    min_spec_ratio: float = Query(0.4, ge=0.0, le=1.0),
):
    """规则简报（结构化）：lead 导语 + 三段榜单，每条带标签。"""
    return _build_brief(day, baseline, gate, min_spec_ratio)


@app.get("/feed/brief.md")
def feed_brief_md(
    day: str = "",
    baseline: int = Query(7, ge=1, le=30),
    gate: int = Query(1, ge=0, le=1),
    min_spec_ratio: float = Query(0.4, ge=0.0, le=1.0),
):
    """规则简报（Markdown 文本）：便于直接发布/播报。"""
    md = brief.render_markdown(_build_brief(day, baseline, gate, min_spec_ratio))
    return PlainTextResponse(md, media_type="text/markdown; charset=utf-8")


@app.get("/api/term/{term}")
def term_detail(term: str, day: str = "", limit: int = Query(30, ge=1, le=100)):
    conn = db.connect()
    if not day:
        row = conn.execute("SELECT MAX(day) AS d FROM term_daily").fetchone()
        day = row["d"] or datetime.date.today().isoformat()
    history = [
        {"day": r["day"], "doc_count": r["doc_count"]}
        for r in conn.execute(
            "SELECT day, doc_count FROM term_daily WHERE term=? ORDER BY day", (term,)
        )
    ]
    rows = [
        dict(r)
        for r in conn.execute(
            "SELECT source, title, content, url, ts, event_id FROM items "
            "WHERE day=? AND (title LIKE ? OR content LIKE ?) ORDER BY ts DESC LIMIT ?",
            (day, f"%{term}%", f"%{term}%", limit),
        )
    ]
    conn.close()
    # 同一事件只展示一条主条（信源最权威的），其余折叠进 related
    groups = {}
    for it in rows:
        groups.setdefault(it["event_id"] or it["url"] or id(it), []).append(it)
    items = []
    for grp in groups.values():
        grp.sort(key=lambda x: (source_tier(x["source"]), -x["ts"]))
        main = grp[0]
        main["related"] = [{"source": g["source"], "url": g["url"], "ts": g["ts"]} for g in grp[1:]]
        items.append(main)
    items.sort(key=lambda x: x["ts"], reverse=True)
    return {"term": term, "day": day, "history": history, "items": items}


@app.get("/api/stats")
def stats():
    conn = db.connect()
    by_source = [dict(r) for r in conn.execute(
        "SELECT source, COUNT(*) AS count FROM items GROUP BY source ORDER BY count DESC"
    )]
    days = [dict(r) for r in conn.execute(
        "SELECT day, COUNT(*) AS count FROM items GROUP BY day ORDER BY day DESC LIMIT 30"
    )]
    conn.close()
    return {"by_source": by_source, "by_day": days}


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
