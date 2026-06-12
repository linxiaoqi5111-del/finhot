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
from .lexicon import (
    GEO_RESCUE, INDUSTRY_ANCHORS, INDUSTRY_THEMES, TYPE_MULTIPLIER,
    classify, entity_themes, geo_themes, has_industry_prefix,
)
from .terms import burst_score

app = FastAPI(title="FinHot 金融热词监控")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "web")


# ---- 准入制：candidate 词必须满足 ≥2 条准入条件才能进产业榜 ----
# 条件：① 命中产业白名单子串  ② 有结构前缀(AI+/液冷+)  ③ 上下文锚点共现≥2
# ④ 与其他产业白名单词共现  ⑤ 来自 T1 产业信源  ⑥ 长度≥3字（更具体）
# 结构硬门槛：抽象后缀词（-性/-度/-化）、角色词（-人/-者）、≤2字短词直接不准入
_MIN_ADMISSION = 2  # 至少满足 N 个条件

# 抽象概念/角色后缀：以这些字结尾的词是概念词或人物角色词，不是产业题材
_ABSTRACT_SUFFIXES = set("性度化感者人家师力内外上下中后前时处于面院所部局委会长式体技")


def _admission_check(conn, day, term):
    """candidate 词准入检查：返回满足的条件数（0 = 结构不合格）。"""
    cjk_len = sum(1 for c in term if "\u4e00" <= c <= "\u9fff")
    # 结构硬门槛：纯中文短词（≤2字）不准入（真题材词进白名单）；抽象/角色后缀词不准入
    if 0 < cjk_len <= 2 and len(term) == cjk_len:
        return 0
    if cjk_len and term[-1] in _ABSTRACT_SUFFIXES:
        return 0
    score = 0

    # ① 包含产业白名单子串（如「液冷服务器」含「液冷」和「服务器」）
    for theme in INDUSTRY_THEMES:
        if len(theme) >= 2 and theme in term and theme != term:
            score += 1
            break

    # ② 有产业结构前缀
    if has_industry_prefix(term):
        score += 1

    # ③④⑤ 需要查数据库
    rows = conn.execute(
        "SELECT source, title, content FROM items WHERE day=? AND (title LIKE ? OR content LIKE ?) LIMIT 50",
        (day, f"%{term}%", f"%{term}%"),
    ).fetchall()
    anchor_hits = set()
    has_theme_cooccur = False
    has_t1_source = False
    for r in rows:
        text = (r["title"] or "") + (r["content"] or "")
        # ③ 产业锚点共现
        for w in INDUSTRY_ANCHORS:
            if w in text and w != term:
                anchor_hits.add(w)
        # ④ 与其他产业白名单词共现
        if not has_theme_cooccur:
            for theme in INDUSTRY_THEMES:
                if len(theme) >= 2 and theme in text and theme != term:
                    has_theme_cooccur = True
                    break
        # ⑤ T1 信源
        if not has_t1_source and source_tier(r["source"]) <= 1.0:
            has_t1_source = True

    if len(anchor_hits) >= 2:
        score += 1
    if has_theme_cooccur:
        score += 1
    if has_t1_source:
        score += 1

    # ⑥ 长度 ≥ 3 字（更具体的短语，如「数据中心」vs「数据」）
    cjk_len = sum(1 for c in term if "\u4e00" <= c <= "\u9fff")
    if cjk_len >= 3 or (not term.isascii() and len(term) >= 3):
        score += 1

    return score


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
            # candidate 准入制：≥3字中文词需≥2条件；英文/混合词需≥3条件（防 AGENT/SUPER 这类泛英文词）
            if ttype == "candidate":
                admission = _admission_check(conn, day, term)
                cjk_len = sum(1 for c in term if "\u4e00" <= c <= "\u9fff")
                min_req = _MIN_ADMISSION if cjk_len >= 3 else 3
                if admission < min_req:
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
