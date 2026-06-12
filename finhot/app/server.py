"""FinHot API + 静态前端。

运行: uvicorn app.server:app --host 0.0.0.0 --port 8000
"""
import datetime
import os

from fastapi import FastAPI, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .events import source_tier
from .lexicon import GEO_RESCUE, INDUSTRY_THEMES, TYPE_MULTIPLIER, classify, entity_themes, geo_themes
from .terms import burst_score

app = FastAPI(title="FinHot 金融热词监控")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "web")


# 产业语境关键词：用于判断候选词是否有产业上下文
INDUSTRY_CONTEXT = set("""
订单 产能 扩产 投产 量产 招标 中标 供应 供应商 产业链 上游 下游 渗透率 市占率 出货量
价格 涨价 提价 降价 报价 均价 出厂价 含税价 现货价 期货价
技术路线 专利 突破 验证 送样 试产 商业化 量化 良率 良品率
概念股 龙头 受益 题材 板块 产业 技术 设备 制造 研发 工厂 产线 产品
国产替代 自主可控 关税 补贴 政策
""".split())


def _has_industry_context(conn, day, term):
    """检查同日含该词的快讯是否有产业语境。"""
    rows = conn.execute(
        "SELECT title, content FROM items WHERE day=? AND (title LIKE ? OR content LIKE ?) LIMIT 50",
        (day, f"%{term}%", f"%{term}%"),
    ).fetchall()
    for r in rows:
        text = (r["title"] or "") + (r["content"] or "")
        if any(w in text for w in INDUSTRY_CONTEXT):
            return True
        if any(w in text for w in GEO_RESCUE):
            return True
        # 同样检查产业白名单词出现
        for theme in INDUSTRY_THEMES:
            if len(theme) >= 2 and theme in text and theme != term:
                return True
    return False


def _days_back(day, n):
    d = datetime.date.fromisoformat(day)
    return [(d - datetime.timedelta(days=i)).isoformat() for i in range(n, 0, -1)]


@app.get("/api/hotwords")
def hotwords(
    day: str = "",
    baseline: int = Query(7, ge=1, le=30),
    limit: int = Query(50, ge=1, le=200),
    gate: int = Query(1, ge=0, le=1),
    min_spec_ratio: float = Query(0.4, ge=0.0, le=1.0),
    board: str = Query("industry", pattern="^(industry|event|entity)$"),
):
    conn = db.connect()
    if not day:
        row = conn.execute("SELECT MAX(day) AS d FROM term_daily").fetchone()
        day = row["d"] or datetime.date.today().isoformat()
    base_days = _days_back(day, baseline)
    today_rows = conn.execute("SELECT term, doc_count, spec_count, weight FROM term_daily WHERE day=?", (day,)).fetchall()
    placeholders = ",".join("?" * len(base_days))
    hist, hist_w = {}, {}
    for r in conn.execute(
        f"SELECT term, day, doc_count, weight FROM term_daily WHERE day IN ({placeholders})", base_days
    ):
        hist.setdefault(r["term"], {})[r["day"]] = r["doc_count"]
        hist_w.setdefault(r["term"], {})[r["day"]] = r["weight"]

    results = []
    for r in today_rows:
        term, today_count, spec_count = r["term"], r["doc_count"], r["spec_count"]
        today_w = r["weight"] or today_count  # 旧数据 weight=0 时退回事件数
        spec_ratio = spec_count / today_count if today_count else 0.0
        if gate and board == "industry" and spec_ratio < min_spec_ratio:
            continue
        h = hist.get(term, {})
        hw = hist_w.get(term, {})
        baseline_avg = sum(h.values()) / len(base_days)
        baseline_w = sum(hw[d] or h[d] for d in hw) / len(base_days)
        score, lift = burst_score(today_w, baseline_w)
        if gate and board == "industry":
            score = round(score * spec_ratio, 2)
        ttype = classify(term)
        if board == "industry":
            if ttype in ("entity", "event", "geo"):
                continue
            mult = TYPE_MULTIPLIER[ttype]
            # candidate 词必须有产业上下文才能上榜
            if ttype == "candidate" and not _has_industry_context(conn, day, term):
                continue
            score = round(score * mult, 2)
        elif board == "event":
            if ttype not in ("event", "geo"):
                continue
        elif board == "entity":
            if ttype != "entity":
                continue
        themes = []
        if ttype == "entity":
            themes = entity_themes(term)
        elif ttype == "geo":
            themes = geo_themes(term)
        results.append({
            "term": term,
            "type": ttype,
            "themes": themes,
            "today": today_count,
            "weight": round(today_w, 2),
            "spec_count": spec_count,
            "spec_ratio": round(spec_ratio, 2),
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
