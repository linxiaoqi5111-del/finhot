"""FinHot API + 静态前端。

运行: uvicorn app.server:app --host 0.0.0.0 --port 8000
"""
import datetime
import os

from fastapi import FastAPI, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .terms import burst_score

app = FastAPI(title="FinHot 金融热词监控")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "web")


def _days_back(day, n):
    d = datetime.date.fromisoformat(day)
    return [(d - datetime.timedelta(days=i)).isoformat() for i in range(n, 0, -1)]


@app.get("/api/hotwords")
def hotwords(day: str = "", baseline: int = Query(7, ge=1, le=30), limit: int = Query(50, ge=1, le=200)):
    conn = db.connect()
    if not day:
        row = conn.execute("SELECT MAX(day) AS d FROM term_daily").fetchone()
        day = row["d"] or datetime.date.today().isoformat()
    base_days = _days_back(day, baseline)
    today_rows = conn.execute("SELECT term, doc_count FROM term_daily WHERE day=?", (day,)).fetchall()
    placeholders = ",".join("?" * len(base_days))
    hist = {}
    for r in conn.execute(
        f"SELECT term, day, doc_count FROM term_daily WHERE day IN ({placeholders})", base_days
    ):
        hist.setdefault(r["term"], {})[r["day"]] = r["doc_count"]

    results = []
    for r in today_rows:
        term, today_count = r["term"], r["doc_count"]
        h = hist.get(term, {})
        baseline_avg = sum(h.values()) / len(base_days)
        score, lift = burst_score(today_count, baseline_avg)
        results.append({
            "term": term,
            "today": today_count,
            "baseline_avg": round(baseline_avg, 2),
            "lift": lift,
            "score": score,
            "is_new": not h,
            "trend": [h.get(d, 0) for d in base_days] + [today_count],
            "trend_days": base_days + [day],
        })
    results.sort(key=lambda x: x["score"], reverse=True)
    total_items = conn.execute("SELECT COUNT(*) AS c FROM items WHERE day=?", (day,)).fetchone()["c"]
    conn.close()
    return {"day": day, "total_items": total_items, "hotwords": results[:limit]}


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
    items = [
        dict(r)
        for r in conn.execute(
            "SELECT source, title, content, url, ts FROM items "
            "WHERE day=? AND (title LIKE ? OR content LIKE ?) ORDER BY ts DESC LIMIT ?",
            (day, f"%{term}%", f"%{term}%", limit),
        )
    ]
    conn.close()
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
