#!/usr/bin/env python3
"""离线单测（无网络）：promote_l3 抽字纯函数。

用代表性正文片段覆盖：金额抽取/归一、fact_status 三态判定（partial>planned>realized）、
中介/合规声明拒绝、占营收比。运行：
    python3 -m unittest discover -s skills/cninfo-rss/tests
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import promote_l3 as p  # noqa: E402

# —— 代表性正文片段（取自真实公告，缩短）——
ZHONGBIAO = (
    "公司收到《中标通知书》，被确定为该项目中标人。中标金额为人民币贰亿柒仟捌佰肆拾肆万"
    "（¥278,440,432.25），其中施工费为（¥272,990,932.25）。项目工期：730 日历天。"
    "上述项目中标金额占公司 2025 年度经审计营业收入的 2.47%。"
    "公司尚未与项目业主方正式签订合同，因此合同条款尚存在不确定性。"
)
TOUCHAN = (
    "公司全资子公司投资建设的项目部分生产线陆续进入开车试生产阶段。"
    "项目计划总投资 596,188 万元，整体设计产能为年产 3 万吨。"
    "目前项目首期 3 条生产线陆续进入开车试生产阶段。"
)
YUPILU = "公司持股 5% 以上股东拟以集中竞价方式减持股份，现进行减持预披露。"
INTERMEDIARY = (
    "长江证券承销保荐有限公司及本公司经办人员均不存在不得参与任何上市公司"
    "重大资产重组的情形。"
)
REALIZED = "公司已完成对标的公司 100% 股权的收购并完成工商变更登记。"


class TestAmounts(unittest.TestCase):
    def test_yuan_precise_and_sort(self):
        a = p.find_amounts(ZHONGBIAO)
        self.assertEqual(a[0]["value_yuan"], 278440432.25)  # 降序，最大在前
        self.assertEqual(a[0]["unit"], "元")

    def test_wan_unit_multiplier(self):
        a = p.find_amounts(TOUCHAN)
        self.assertTrue(any(x["value_yuan"] == 596188 * 10000 for x in a))

    def test_no_amount(self):
        self.assertEqual(p.find_amounts("无金额信息的纯文字公告"), [])


class TestFactStatus(unittest.TestCase):
    def test_zhongbiao_partial(self):
        # 中标但「尚未签订合同」→ partially_realized（不能当已落地合同）
        self.assertEqual(p.classify_fact_status(ZHONGBIAO)[0], "partially_realized")

    def test_touchan_partial_over_planned(self):
        # 含「计划总投资」却也含「试生产」→ partial 必须压过 planned
        self.assertEqual(p.classify_fact_status(TOUCHAN)[0], "partially_realized")

    def test_yupilu_planned(self):
        self.assertEqual(p.classify_fact_status(YUPILU)[0], "planned")

    def test_realized_fallback(self):
        self.assertEqual(p.classify_fact_status(REALIZED)[0], "realized")


class TestIntermediaryNoise(unittest.TestCase):
    def test_reject_intermediary(self):
        f = p.extract_facts(INTERMEDIARY, {})
        self.assertFalse(f["l3_usable"])
        self.assertIn("不得参与", f["reject_reason"])

    def test_usable_when_clean(self):
        self.assertTrue(p.extract_facts(ZHONGBIAO, {})["l3_usable"])


class TestExtractFacts(unittest.TestCase):
    def test_full_draft_fields(self):
        f = p.extract_facts(ZHONGBIAO, {})
        self.assertEqual(f["fact_status"], "partially_realized")
        self.assertIn("amount", f["extracted_fields"])
        self.assertIn("revenue_impact", f["extracted_fields"])
        self.assertIn("duration", f["extracted_fields"])
        # 每个字段都带证据，便于人工回溯
        self.assertTrue(f["extracted_fields"]["amount"]["evidence"])

    def test_promote_safety_envelope(self):
        # 不论可用与否，草稿恒为「不入库」状态
        d = p.promote({"sec_name": "X", "title": "t"}, text=INTERMEDIARY)
        self.assertTrue(d["review_required"])
        self.assertTrue(d["not_applied"])
        self.assertEqual(d["ingest_status"], "parsed_draft")


if __name__ == "__main__":
    unittest.main()
