"""重算所有已入库日期的词频（修改算法/停用词/权重后使用）。"""
from app import db
from app.collector import recount_day

conn = db.connect()
days = [r["day"] for r in conn.execute("SELECT DISTINCT day FROM items ORDER BY day")]
for day in days:
    with conn:
        recount_day(conn, day)
    n = conn.execute("SELECT COUNT(*) FROM term_daily WHERE day=?", (day,)).fetchone()[0]
    print(day, n, "terms")
conn.close()
