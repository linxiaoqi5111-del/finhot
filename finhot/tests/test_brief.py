"""规则简报单测：标签规则（NEW/突发/高浓度）、导语生成、Markdown 渲染、空榜兜底。

运行：在 finhot/ 目录下 `python -m unittest discover -s tests`
"""
import os
import tempfile
import unittest

from app import brief, db


def _feed(industry=None, event=None, entity=None):
    return {
        "generated_at": 1781600000,
        "day": "2026-06-16",
        "total_items": 803,
        "baseline": 7,
        "gate": 1,
        "boards": {
            "industry": industry or [],
            "event": event or [],
            "entity": entity or [],
        },
    }


_IND = {"term": "液冷", "type": "industry", "themes": [], "today": 10,
        "score": 11.87, "lift": 13.0, "spec_ratio": 0.6, "is_new": True}
_EV = {"term": "降息", "type": "event", "themes": [], "today": 8,
       "score": 9.4, "lift": 9.0, "spec_ratio": 0.12, "is_new": True}
_EN = {"term": "英伟达", "type": "entity", "themes": ["GPU", "算力"], "today": 5,
       "score": 4.0, "lift": 2.0, "spec_ratio": 0.4, "is_new": False}


class TagRuleTest(unittest.TestCase):
    def test_industry_tags_new_burst_hotspec(self):
        b = brief.build_brief(_feed(industry=[_IND]))
        item = b["sections"][0]["items"][0]
        self.assertEqual(item["tags"], ["NEW", "突发×13.0", "高浓度"])

    def test_event_no_hotspec_tag(self):
        """高浓度标签只给产业词，事件词不打。"""
        b = brief.build_brief(_feed(event=[{**_EV, "spec_ratio": 0.9}]))
        ev = next(s for s in b["sections"] if s["board"] == "event")["items"][0]
        self.assertNotIn("高浓度", ev["tags"])

    def test_low_lift_old_word_no_tags(self):
        b = brief.build_brief(_feed(entity=[_EN]))
        en = next(s for s in b["sections"] if s["board"] == "entity")["items"][0]
        self.assertEqual(en["tags"], [])


class LeadTest(unittest.TestCase):
    def test_lead_mentions_top_industry_and_event(self):
        b = brief.build_brief(_feed(industry=[_IND], event=[_EV]))
        self.assertIn("液冷", b["lead"])
        self.assertIn("降息", b["lead"])

    def test_lead_empty_when_no_hotspots(self):
        b = brief.build_brief(_feed())
        self.assertIn("无显著热点", b["lead"])


class RenderTest(unittest.TestCase):
    def test_markdown_structure(self):
        b = brief.build_brief(_feed(industry=[_IND], event=[_EV], entity=[_EN]))
        md = brief.render_markdown(b)
        self.assertIn("# 🔥 FinHot 简报 · 2026-06-16", md)
        self.assertIn("当日快讯 803 条", md)
        self.assertIn("今日要点", md)
        self.assertIn("## 📈 产业题材", md)
        self.assertIn("## ⚡ 催化事件", md)
        self.assertIn("## 🏢 实体异动", md)
        self.assertIn("1. **液冷**", md)
        self.assertIn("`NEW`", md)
        self.assertIn("英伟达** → GPU / 算力", md)

    def test_empty_board_renders_placeholder(self):
        md = brief.render_markdown(brief.build_brief(_feed(industry=[_IND])))
        self.assertIn("_暂无_", md)  # 事件/实体榜空


class FromDbTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._orig = db.DB_PATH
        db.DB_PATH = os.path.join(self.tmp, "test.db")
        self.conn = db.connect()
        with self.conn:
            self.conn.executemany(
                "INSERT INTO term_daily (term, day, doc_count, spec_count, weight) VALUES (?,?,?,?,?)",
                [("液冷", "2026-06-16", 10, 6, 12.0), ("降息", "2026-06-16", 8, 1, 8.0)],
            )
            self.conn.executemany(
                "INSERT INTO items (id, source, title, content, ts, day, admitted) VALUES (?,?,?,?,?,?,1)",
                [(f"it{i}", "财联社", "", "液冷服务器订单 降息", 0, "2026-06-16") for i in range(5)],
            )

    def tearDown(self):
        self.conn.close()
        db.DB_PATH = self._orig

    def test_build_brief_from_db(self):
        b = brief.build_brief_from_db(self.conn, day="2026-06-16", gate=1)
        self.assertEqual(b["day"], "2026-06-16")
        self.assertIn("液冷", {it["term"] for it in b["sections"][0]["items"]})
        md = brief.render_markdown(b)
        self.assertIn("FinHot 简报", md)


if __name__ == "__main__":
    unittest.main()
