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


class TestExcludeST(unittest.TestCase):
    def test_risk_warned_names(self):
        for name in ("ST龙大", "*ST禾信", "*ST明德", "SST前锋", "S*ST佳通", "st板眼", "* ST 全角", "园城退"):
            self.assertTrue(fc._is_risk_warned(name), name)

    def test_normal_names_kept(self):
        for name in ("北新路桥", "中复神鹰", "贵州茅台", "宁德时代", "STO测试不存在", "顺丰控股"):
            self.assertFalse(fc._is_risk_warned(name), name)

    def test_collect_filters_st(self):
        # collect 末段应按 exclude_st 剔除 ST 股；用假 client 注入两条公告验证
        class _FakeClient:
            def iter_announcements(self, **kw):
                yield {"secCode": "002726", "secName": "ST龙大", "announcementId": "a1",
                       "announcementTitle": "关于签订重大合同的公告", "announcementTime": 1782748800000}
                yield {"secCode": "002307", "secName": "北新路桥", "announcementId": "a2",
                       "announcementTitle": "关于签订重大合同的公告", "announcementTime": 1782748800000}

        cfg = dict(_cfg())
        cfg.update({"markets": [], "watchlist_codes": [], "exclude_st": True,
                    "hard_delta_combo_rules": {}})
        names = {r["sec_name"] for r in fc.collect(cfg, client=_FakeClient())}
        self.assertIn("北新路桥", names)
        self.assertNotIn("ST龙大", names)
        # 关掉开关则保留
        cfg["exclude_st"] = False
        names2 = {r["sec_name"] for r in fc.collect(cfg, client=_FakeClient())}
        self.assertIn("ST龙大", names2)


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

    def test_prepublish_demoted(self):
        # 预披露=未实施的减持计划：即使 减持+股份 组合满足，也因 low 词降级
        cfg = dict(self.cfg)
        cfg["l3_title_keywords"] = {"include_any": ["减持"], "exclude_any": []}
        cfg["fact_type_by_keyword"] = {"减持": "share_change"}
        cfg["hard_delta_combo_rules"] = {"减持": ["股份", "股东"]}
        cfg["low_confidence_keywords"] = ["预披露"]
        out = fc.classify(self._rec("关于股东减持股份预披露公告"), cfg)
        self.assertEqual(out["update_type"], "review_candidate")
        self.assertEqual(out["fact_status"], "planned")


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

    def test_summary_localized_zh(self):
        # whitebox feed 的 <summary> 应显示中文字段名+枚举，而非英文
        recs = [{
            "announcement_id": "9", "sec_code": "300001", "sec_name": "测试",
            "title": "关于签订重大合同的公告", "published_at": "2026-06-30T08:00:00+08:00",
            "pdf_url": "http://x/y.PDF", "detail_url": "https://x/d",
            "category_code": "category_gqbd_szsh", "fact_type": "share_change",
            "update_type": "review_candidate", "confidence": "low",
            "l3_match_reason": "category:股权变动|combo_miss",
        }]
        xml = emit_rss.build_atom("t", "测试 feed", recs)
        # 只校验用户可见的 <summary>（推荐理由展示位）；<category term> 保留英文稳定机器键
        summary = minidom.parseString(xml).getElementsByTagName("summary")[0].firstChild.data
        self.assertIn("事实类型：增减持", summary)
        self.assertIn("判定：待核候选", summary)
        self.assertIn("确定性：低", summary)
        self.assertIn("分类:股权变动", summary)
        self.assertIn("缺伴随词", summary)
        # summary 内不应再出现英文枚举/字段名
        for token in ("fact_type:", "update_type:", "hard_delta", "share_change", "combo_miss"):
            self.assertNotIn(token, summary)


class TestWriteFeeds(unittest.TestCase):
    def test_stale_renamed_feed_removed(self):
        # 改名后 write_feeds 应清掉残留旧文件，避免订阅端静默读陈旧 feed
        import tempfile

        rec = {
            "announcement_id": "1", "sec_code": "300001", "sec_name": "测试",
            "title": "关于签订重大合同的公告", "published_at": "2026-06-30T08:00:00+08:00",
            "pdf_url": "", "detail_url": "", "category_code": "",
            "fact_type": "order_contract", "update_type": "hard_delta",
            "confidence": "high", "l3_match_reason": "keyword:签订",
        }
        with tempfile.TemporaryDirectory() as d:
            rss_dir = Path(d)
            stale = rss_dir / "l3-hard-delta.xml"
            stale.write_text("<old/>", encoding="utf-8")
            emit_rss.write_feeds([rec], rss_dir, {"l3_categories": [], "watchlist_codes": []})
            self.assertFalse(stale.exists())
            self.assertTrue((rss_dir / "l3-candidates-hard-delta.xml").exists())


if __name__ == "__main__":
    unittest.main()
