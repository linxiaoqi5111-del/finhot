"""采集入口：抓取所有源 -> 入库 -> 重算当日词频。

用法:
    python -m app.collector            # 抓一次
    python -m app.collector --loop 30  # 每30分钟抓一次
"""
import argparse
import datetime
import sys
import time

from . import db
from .sources import fetch_all
from .terms import count_daily_terms
from .watchlist import fetch_watchlist


def day_of(ts):
    return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def collect_once():
    items, errors = fetch_all()
    wl_items, wl_errors = fetch_watchlist()
    items.extend(wl_items)
    errors.update(wl_errors)
    conn = db.connect()
    new = 0
    days = set()
    with conn:
        for it in items:
            day = day_of(it["ts"])
            cur = conn.execute(
                "INSERT OR IGNORE INTO items (id, source, title, content, url, ts, day) VALUES (?,?,?,?,?,?,?)",
                (it["id"], it["source"], it["title"], it["content"], it["url"], it["ts"], day),
            )
            if cur.rowcount:
                new += 1
                days.add(day)
        for day in days:
            rows = conn.execute("SELECT title, content FROM items WHERE day=?", (day,)).fetchall()
            docs = [(r["title"] or "") + " " + (r["content"] or "") for r in rows]
            counts = count_daily_terms(docs)
            conn.execute("DELETE FROM term_daily WHERE day=?", (day,))
            conn.executemany(
                "INSERT INTO term_daily (term, day, doc_count, spec_count) VALUES (?,?,?,?)",
                [(t, day, c, s) for t, (c, s) in counts.items()],
            )
    conn.close()
    print(f"[collector] fetched={len(items)} new={new} days_recomputed={sorted(days)} errors={errors}")
    return new, errors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--loop", type=int, default=0, help="循环间隔（分钟），0=只跑一次")
    args = parser.parse_args()
    while True:
        try:
            collect_once()
        except Exception as e:  # noqa: BLE001
            print(f"[collector] error: {e}", file=sys.stderr)
        if not args.loop:
            break
        time.sleep(args.loop * 60)


if __name__ == "__main__":
    main()
