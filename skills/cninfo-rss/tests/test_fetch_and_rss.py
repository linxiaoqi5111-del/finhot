#!/usr/bin/env python3
"""离线单测（无网络）：覆盖毫秒时间戳转换、去重、关键词 exclude、Atom 合法性。

运行：
    python3 -m unittest discover -s skills/cninfo-rss/tests
    # 或（装了 pytest）：pytest skills/cninfo-rss/tests
"""
import sys
import unittest
from pathlib import Path
from xml.dom import minidom

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import fetch_cninfo as fc  # noqa: E402
import emit_rss  # noqa: E402
import state as state_mod  # noqa: E402


def _cfg():
    return {
        "l3_categories": [
            {"code": "category_gqjl_szsh", "name": "股权激励", "fact_types": ["equity_incentive"], "enabled": True},
        ],
        "l3_title_keywords": {
            "include_any": ["中标", "重大合同", "增持"],
            "exclude_any": ["董事会决议", "核查意见", "理财"],
        },
        "low_confidence_keywords": ["拟", "计划"],
        "fact_type_by_keyword": {"中标": "order_contract", "重大合同": "order_contract", "增持": "share_change"},
        "default_fact_type": "other_hard",
    }


class TestTimestamp(unittest.TestCase):
    def test_ms_to_iso(self):
        # 1782748800000 ms = 2026-06-30 00:00:00 +08:00
        self.assertEqual(fc.ts_to_iso(1782748800000), "2026-06-30T00:00:00+08:00")

    def test_ms_string(self):
        self.assertTrue(fc.ts_to_iso("1782748800000").startswith("2026-06-30T"))

    def test_blank(self):
        self.assertEqual(fc.ts_to_iso(None), "")
        self.assertEqual(fc.ts_to_iso(""), "")

    def test_not_raw_ms(self):
        # 输出绝不能是原始毫秒字符串
        out = fc.ts_to_iso(1782748800000)
        self.assertNotIn("1782748800000", out)
        self.assertRegex(out, r"^\d{4}-\d{2}-\d{2}T")


class TestClassify(unittest.TestCase):
    def setUp(self):
        self.cfg = _cfg()

    def _rec(self, title, code="300001", cat=""):
        return {"title": title, "sec_code": code, "sec_name": "测试", "category_code": cat,
                "announcement_id": "1", "published_at": "2026-06-30T08:00:00+08:00"}

    def test_exclude_wins(self):
        # 命中 exclude_any → 直接丢弃，即使分类命中
        r = self._rec("关于激励计划的核查意见", cat="category_gqjl_szsh")
        self.assertIsNone(fc.classify(r, self.cfg))

    def test_exclude_keyword(self):
        self.assertIsNone(fc.classify(self._rec("关于使用闲置资金购买理财产品的董事会决议"), self.cfg))

    def test_category_match(self):
        # 注意：避开低确定性词（如"计划"）才会判为 hard_delta
        out = fc.classify(self._rec("限制性股票授予登记完成的公告", cat="category_gqjl_szsh"), self.cfg)
        self.assertIsNotNone(out)
        # 正文未解析 → 按 KB 口径只能标候选，不能直接 L3 hard_fact
        self.assertEqual(out["evidence_layer"], "L1_L3_candidate")
        self.assertEqual(out["fact_hardness"], "review_candidate")
        self.assertTrue(out["review_required"])
        self.assertEqual(out["fact_type"], "equity_incentive")
        self.assertEqual(out["update_type"], "hard_delta")
        self.assertTrue(out["l3_match_reason"].startswith("category:"))

    def test_keyword_match(self):
        out = fc.classify(self._rec("关于收到中标通知书的公告"), self.cfg)
        self.assertIsNotNone(out)
        self.assertEqual(out["fact_type"], "order_contract")
        self.assertEqual(out["confidence"], "high")

    def test_low_confidence_downgrade(self):
        out = fc.classify(self._rec("关于拟签订重大合同的提示性公告"), self.cfg)
        self.assertIsNotNone(out)
        self.assertEqual(out["update_type"], "review_candidate")
        self.assertEqual(out["confidence"], "low")
        self.assertIn("low:", out["l3_match_reason"])

    def test_no_match(self):
        self.assertIsNone(fc.classify(self._rec("关于公司地址变更的公告"), self.cfg))


class TestCategoryTitleGate(unittest.TestCase):
    """分类命中后的标题二次校验（粗筛 → 准入门）。"""

    def setUp(self):
        self.cfg = {
            "l3_categories": [
                {
                    "code": "category_gqbd_szsh",
                    "name": "股权变动",
                    "fact_types": ["share_change"],
                    "enabled": True,
                    "title_include_any": ["增持", "减持", "权益变动"],
                },
            ],
            "l3_title_keywords": {"include_any": ["中标"], "exclude_any": ["董事会决议"]},
            "low_confidence_keywords": [],
            "fact_type_by_keyword": {"中标": "order_contract"},
            "default_fact_type": "other_hard",
        }

    def _rec(self, title, cat="category_gqbd_szsh"):
        return {"title": title, "sec_code": "300001", "sec_name": "测试",
                "category_code": cat, "announcement_id": "1",
                "published_at": "2026-06-30T08:00:00+08:00"}

    def test_category_passes_title_gate(self):
        out = fc.classify(self._rec("关于股东减持股份计划的公告"), self.cfg)
        self.assertIsNotNone(out)
        self.assertEqual(out["fact_type"], "share_change")
        self.assertTrue(out["l3_match_reason"].startswith("category:"))

    def test_category_blocked_by_title_gate(self):
        # 命中分类码但标题没有任何准入词 → 不算分类命中，关键词也不中 → 丢弃
        self.assertIsNone(fc.classify(self._rec("关于公司中介报告的说明"), self.cfg))

    def test_category_title_exclude_drops(self):
        cfg = dict(self.cfg)
        cfg["l3_categories"] = [dict(cfg["l3_categories"][0], title_exclude_any=["质押"])]
        self.assertIsNone(fc.classify(self._rec("关于股东减持及股份质押的公告"), cfg))


class TestComboRules(unittest.TestCase):
    """组合规则：宽词单独命中只算 review_candidate，配伴随词才升 hard_delta。"""

    def setUp(self):
        self.cfg = {
            "l3_categories": [],
            "l3_title_keywords": {"include_any": ["签订", "中标"], "exclude_any": []},
            "low_confidence_keywords": [],
            "fact_type_by_keyword": {"签订": "order_contract", "中标": "order_contract"},
            "hard_delta_combo_rules": {"签订": ["合同", "订单", "协议"]},
            "default_fact_type": "other_hard",
        }

    def _rec(self, title):
        return {"title": title, "sec_code": "300001", "sec_name": "测试",
                "category_code": "", "announcement_id": "1",
                "published_at": "2026-06-30T08:00:00+08:00"}

    def test_combo_satisfied_is_hard(self):
        out = fc.classify(self._rec("关于签订重大合同的公告"), self.cfg)
        self.assertEqual(out["update_type"], "hard_delta")
        self.assertEqual(out["confidence"], "high")

    def test_combo_missing_demotes(self):
        out = fc.classify(self._rec("关于签订意向书的提示性公告"), self.cfg)
        self.assertEqual(out["update_type"], "review_candidate")
        self.assertEqual(out["confidence"], "low")
        self.assertIn("combo_miss", out["l3_match_reason"])

    def test_keyword_without_combo_rule_unaffected(self):
        # 「中标」不在 combo_rules 里 → 不受约束，照常 hard_delta
        out = fc.classify(self._rec("关于收到中标通知书的公告"), self.cfg)
        self.assertEqual(out["update_type"], "hard_delta")


class TestDetailUrl(unittest.TestCase):
    def test_detail_url_has_stockcode_and_announcement_id(self):
        # 回归：巨潮详情页只给 annoId 会 500，必须同时带 stockCode + announcementId
        rec = fc.normalize_raw({
            "secCode": "000603", "announcementId": "1225396198",
            "secName": "盛达资源", "announcementTitle": "2026年半年度业绩预告",
            "announcementTime": 1782748800000,
        })
        self.assertEqual(
            rec["detail_url"],
            "https://www.cninfo.com.cn/new/disclosure/detail"
            "?stockCode=000603&announcementId=1225396198",
        )
        self.assertNotIn("?annoId=", rec["detail_url"])

    def test_detail_url_blank_when_no_id(self):
        rec = fc.normalize_raw({"secCode": "000603", "announcementId": ""})
        self.assertEqual(rec["detail_url"], "")


class TestDedup(unittest.TestCase):
    def test_filter_new(self):
        records = [{"announcement_id": "a"}, {"announcement_id": "b"}, {"announcement_id": "c"}]
        st = {"seen_ids": ["a", "c"], "high_water_ms": 0}
        new = state_mod.filter_new(records, st)
        self.assertEqual([r["announcement_id"] for r in new], ["b"])

    def test_update_state(self):
        st = {"seen_ids": ["a"], "high_water_ms": 100}
        state_mod.update_state(st, [{"announcement_id": "b", "published_ms": 200},
                                    {"announcement_id": "a", "published_ms": 50}])
        self.assertIn("b", st["seen_ids"])
        self.assertEqual(st["seen_ids"].count("a"), 1)
        self.assertEqual(st["high_water_ms"], 200)


class TestAtom(unittest.TestCase):
    def test_wellformed_and_iso(self):
        recs = [{
            "announcement_id": "1225398031", "sec_code": "688689", "sec_name": "银河微电",
            "title": "股权激励计划草案 <带特殊字符&>", "published_at": "2026-06-30T08:00:00+08:00",
            "pdf_url": "http://x/y.PDF", "detail_url": "https://x/d?annoId=1",
            "category_code": "category_gqjl_szsh", "fact_type": "equity_incentive",
            "update_type": "hard_delta", "confidence": "high", "l3_match_reason": "category:股权激励",
        }]
        xml = emit_rss.build_atom("t", "测试 feed", recs)
        dom = minidom.parseString(xml)  # 不抛异常即 well-formed
        published = dom.getElementsByTagName("published")[0].firstChild.data
        self.assertRegex(published, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")
        self.assertNotIn("1782748800000", xml)
        # 特殊字符被正确转义
        self.assertIn("&amp;", xml)


if __name__ == "__main__":
    unittest.main()
