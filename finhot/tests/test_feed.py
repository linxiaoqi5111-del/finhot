"""热榜计算 + JSON feed 单测：三榜拆分、闸口过滤、feed 结构与 /api/hotwords 同源。

运行：在 finhot/ 目录下 `python -m unittest discover -s tests`
"""
import os
import tempfile
import unittest

from app import board, db, feed

DAY = "2026-06-16"

# (term, doc_count, spec_count, weight)：覆盖产业/事件/实体三类 + 一个低炒作浓度产业词
_TERMS = [
    ("液冷", 10, 6, 12.0),     # industry（白名单），spec_ratio=0.6 过闸口
    ("光模块", 10, 1, 11.0),   # industry（白名单），spec_ratio=0.1 被闸口拦
    ("降息", 8, 1, 8.0),        # event
    ("英伟达", 5, 2, 5.0),      # entity
]


class FeedTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._orig_db = db.DB_PATH
        db.DB_PATH = os.path.join(self.tmp, "test.db")
        self.conn = db.connect()
        with self.conn:
            self.conn.executemany(
                "INSERT INTO term_daily (term, day, doc_count, spec_count, weight) VALUES (?,?,?,?,?)",
                [(t, DAY, dc, sc, w) for t, dc, sc, w in _TERMS],
            )
            # 当日入库条目（total_items 来源；admission_check 也会查 items）
            self.conn.executemany(
                "INSERT INTO items (id, source, title, content, ts, day, admitted) "
                "VALUES (?,?,?,?,?,?,1)",
                [(f"it{i}", "财联社", "", "液冷服务器订单放量 降息预期升温 英伟达光模块", 0, DAY)
                 for i in range(12)],
            )

    def tearDown(self):
        self.conn.close()
        db.DB_PATH = self._orig_db

    def test_industry_board_gate_filters_low_spec(self):
        """闸口开启时只留炒作浓度≥0.4 的产业词。"""
        res = board.compute_board(self.conn, day=DAY, gate=1, min_spec_ratio=0.4, board="industry")
        terms = {h["term"] for h in res["hotwords"]}
        self.assertIn("液冷", terms)
        self.assertNotIn("光模块", terms)   # spec_ratio 0.1 被拦
        self.assertNotIn("降息", terms)     # 事件词不进产业榜
        self.assertNotIn("英伟达", terms)   # 实体词不进产业榜

    def test_industry_board_gate_off_keeps_low_spec(self):
        """关闭闸口后低炒作浓度产业词也回来。"""
        res = board.compute_board(self.conn, day=DAY, gate=0, board="industry")
        terms = {h["term"] for h in res["hotwords"]}
        self.assertIn("液冷", terms)
        self.assertIn("光模块", terms)

    def test_event_and_entity_boards(self):
        """事件榜含降息、实体榜含英伟达且带题材映射。"""
        ev = board.compute_board(self.conn, day=DAY, board="event")
        self.assertIn("降息", {h["term"] for h in ev["hotwords"]})
        en = board.compute_board(self.conn, day=DAY, board="entity")
        nvda = next(h for h in en["hotwords"] if h["term"] == "英伟达")
        self.assertEqual(nvda["type"], "entity")
        self.assertTrue(nvda["themes"])  # 映射到 GPU/算力等题材

    def test_results_sorted_by_score_desc(self):
        res = board.compute_board(self.conn, day=DAY, gate=0, board="industry")
        scores = [h["score"] for h in res["hotwords"]]
        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_hotword_fields_complete(self):
        res = board.compute_board(self.conn, day=DAY, gate=1, board="industry")
        h = res["hotwords"][0]
        for k in ("term", "type", "themes", "today", "weight", "spec_ratio",
                  "baseline_avg", "lift", "score", "is_new", "trend", "trend_days"):
            self.assertIn(k, h)
        self.assertEqual(len(h["trend"]), len(h["trend_days"]))

    def test_build_hot_feed_structure(self):
        """feed 含三榜 + 元信息，且与 compute_board 同源。"""
        f = feed.build_hot_feed(self.conn, day=DAY, gate=1)
        self.assertEqual(f["day"], DAY)
        self.assertEqual(set(f["boards"]), {"industry", "event", "entity"})
        self.assertIn("generated_at", f)
        self.assertEqual(f["total_items"], 12)
        self.assertIn("液冷", {h["term"] for h in f["boards"]["industry"]})
        self.assertIn("降息", {h["term"] for h in f["boards"]["event"]})

    def test_resolve_day_picks_latest(self):
        """空 day 时取库内最新一天。"""
        self.assertEqual(board.resolve_day(self.conn, ""), DAY)
        f = feed.build_hot_feed(self.conn, day="", gate=1)
        self.assertEqual(f["day"], DAY)


if __name__ == "__main__":
    unittest.main()
