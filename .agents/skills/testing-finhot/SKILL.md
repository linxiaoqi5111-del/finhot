---
name: testing-finhot
description: End-to-end test the FinHot financial hot-word dashboard (finhot/ subdir — FastAPI app/server.py + web/index.html). Use when verifying FinHot UI or API changes (admission funnel, board leaderboards, A股炒作闸口 gate, detail-pane per-item score/存档/同事件, /feed endpoints). Covers seeding a deterministic SQLite DB because real financial sources are anti-bot blocked from the VM.
---

# Testing FinHot dashboard (e2e)

FinHot ingests financial 快讯, scores/admits items at ingest, and renders 3 leaderboards
(产业题材榜 / 催化事件榜 / 实体异动榜) plus machine-readable feeds. Pure code + word tables, **no ML models**.

## Why seed a DB instead of running the collector
Real sources (e.g. cls.cn) are anti-bot blocked from this VM (HTTP 418), so a live collector round will
not complete. For UI/API testing, seed a **deterministic synthetic SQLite DB** and point the server at it via
the `FINHOT_DB` env var. (If the block is ever lifted, a real collector round becomes the more faithful test;
until then, seeding is the reliable path.)

## Devin Secrets Needed
None. Everything runs locally with synthetic data; no logins or API keys are required.

## Setup
```bash
cd <repo>/finhot
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt   # requests/jieba/fastapi/uvicorn
python -m unittest discover -s tests        # sanity: ~48 stdlib unittests should pass
```

## DB schema the seed must satisfy (see app/db.py)
- `items(id, source, title, content, url, ts, day, event_id, score, admitted, dup_group, ...)`
- `term_daily(term, day, doc_count, spec_count, weight, PK(term,day))`
- Funnel semantics used by `/api/stats` `by_day`:
  - **准入 (admitted)** = `admitted=1 AND dup_group IS NULL` (representative item)
  - **去重 (deduped)** = `dup_group IS NOT NULL` (follower folded under a representative's event_id)
  - **存档 (archived)** = `admitted=0` (low score, kept but not counted)
- Detail-pane (`/api/term/{term}`) groups items by event_id/url and returns per-item `score` + `admitted` +
  a `related[]` list (the deduped followers → rendered as `+N 同事件`).

Seed tips for a clean demo: give each board term several admitted reps with descending scores
(e.g. 0.82/0.71/0.63), one deduped follower (shares a rep's event_id, distinct dup_group), and one archived
item (admitted=0, score < 0.45 so it shows the 存档 badge). Populate `term_daily` for ~8 days so the trend
chart and 突发倍数 (lift) render. Put A股炒作 signal words (涨停/概念股/题材/订单/中标/股票代码) in some items
so 炒作浓度 (spec_ratio) is non-trivial; keep one industry term's spec_ratio < `min_spec_ratio` (0.4) to demo
the gate filter. Classification lives in app/lexicon.py (INDUSTRY_THEMES / EVENT_WORDS / ENTITY_THEMES) — pick
terms that already exist there so they land on the right board (industry vs event vs entity).

## Run the server against the seeded DB
```bash
cd <repo>/finhot && . .venv/bin/activate
FINHOT_DB=/tmp/finhot_demo.db uvicorn app.server:app --host 127.0.0.1 --port 8013
```
Dashboard: http://127.0.0.1:8013/  (verify endpoints with curl before driving the browser:
`/api/stats`, `/api/hotwords`, `/api/term/<term>`, `/feed/hot.json`, `/feed/brief.md`).

## The 5 UI assertions (each distinguishes working-vs-broken)
1. **Toolbar admission funnel** (fed by `/api/stats`): reads `… · 准入 N · 去重 N · 存档 N · 候选热词 N+`.
   If the funnel backend were missing, the 准入/去重/存档 segment would be absent.
2. **Three boards** (fed by `/api/hotwords` → `app/board.compute_board`): industry/event/entity tabs each
   populate; terms land on the correct board; NEW badge on terms with no baseline; entity rows show theme tags.
3. **A股炒作闸口 gate**: switching 开↔关 must change visibility of a low-spec industry term (e.g. 光模块,
   spec_ratio < 0.4 hidden when 开). If visibility doesn't change, the gate has no effect.
4. **Detail pane** (fed by `/api/term`): click a board row → header `相关快讯 N 条 · 历史覆盖 M 天` + trend chart;
   every item shows `分 X` (入库分); the low-score item shows a grey `存档` badge; a deduped follower shows
   `+N 同事件`. Missing `分` ⇒ score not returned; missing 存档 ⇒ admitted not surfaced.
5. **New feeds**: `/feed/brief.md` renders Markdown (导语 + 3 sections + tags 突发×N / NEW / 高浓度);
   `/feed/hot.json` returns `boards.industry/event/entity` + `total_items`.

Supplementary shell evidence (not in the recording): `python -m unittest discover -s tests`;
`python -m app.brief` (prints the Markdown briefing); `python -m app.feeds_import <opml> --dry-run`
(previews new RSS feeds, no write to watchlist.json).

## Gotchas / future-proofing
- **CJK truncation in curl output**: the PTY truncates wide CJK chars in terminal display (e.g. 液冷→液) — this
  is cosmetic only; the JSON payload is correct. Prefer reading the page HTML/zoomed screenshots to confirm text.
- **devinid values are not stable**: they are assigned per page render. Re-read the page HTML each session to map
  日期/基线/闸口 selects, 刷新 button, the 3 board tabs, and board rows before clicking — do not hardcode them.
- **Selects are native dropdowns**: click to open, then click the option; verify via the `selectedindex`/`selected`
  attributes in the page HTML.
- **Score threshold**: an item is admitted (counts toward 热度) only when its 入库分 ≥ 0.45; below that it is 存档.
  Seed an archived item with score < 0.45 (e.g. 0.38) so the 存档 badge actually appears.
- Don't commit seed scripts, seeded DBs, screenshots, or `.venv/`/`data/`/`__pycache__` (all gitignored / non-functional).
