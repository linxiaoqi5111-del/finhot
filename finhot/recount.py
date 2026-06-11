"""重算所有已入库日期的词频（修改算法/停用词后使用）。"""
from app import db
from app.terms import count_daily_terms

conn = db.connect()
days = [r["day"] for r in conn.execute("SELECT DISTINCT day FROM items")]
for day in days:
    rows = conn.execute("SELECT title, content FROM items WHERE day=?", (day,)).fetchall()
    docs = [(r["title"] or "") + " " + (r["content"] or "") for r in rows]
    counts = count_daily_terms(docs)
    with conn:
        conn.execute("DELETE FROM term_daily WHERE day=?", (day,))
        conn.executemany(
            "INSERT INTO term_daily (term, day, doc_count) VALUES (?,?,?)",
            [(t, day, c) for t, c in counts.items()],
        )
    print(day, len(counts), "terms")
conn.close()
