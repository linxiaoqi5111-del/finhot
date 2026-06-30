"""triage 打分器离线单测（无网络、不强依赖 PyYAML）。

设计原则：核心断言不依赖 fetch_cninfo.classify 是否可用——
- assign_level 用合成 dims 直测规则表（纯函数）；
- 反证路径靠 detect_negation + matched_keywords 锚点触发，与 classify 解耦；
- inquiry 源在 _classify_fact_hardness 里被显式跳过，结果确定。

运行（cwd = finhot/finhot）：
    python3 -m unittest disclosure_lookup.tests.test_triage -v
"""
import unittest

from disclosure_lookup.schema import DisclosureRecord
from disclosure_lookup.triage import (
    DIMENSIONS,
    _detect_product_progress,
    _fc_and_cfg,
    _is_noise,
    _keyword_negated,
    assign_level,
    detect_negation,
    score_dimensions,
    triage,
)

# 装饰期求值：cninfo 税法（PyYAML + cninfo-rss/config.yaml）在则跑集成用例，不在则跳过
_HAVE_CNINFO_CFG = _fc_and_cfg()[1] is not None


def _rec(**kw) -> DisclosureRecord:
    base = dict(
        company_name="X",
        company_code="688323",
        source="cninfo",
        title="",
        url="",
        published_at="2026-06-30T00:00:00+08:00",
    )
    base.update(kw)
    return DisclosureRecord(**base)


class TestAssignLevel(unittest.TestCase):
    """定级规则表（硬门槛自上而下首个命中；score 仅同级排序）。"""

    def _dims(self, **over):
        d = {k: 1 for k in DIMENSIONS}
        d.update(over)
        return d

    def test_p0_positive_hard_fact(self):
        dims = self._dims(fact_hardness=3, lifecycle_impact=2, source_authority=3)
        self.assertEqual(assign_level(dims)[0], "P0")

    def test_p0_reverse_evidence(self):
        # 反证：硬度被强制 3 + 生命周期 3 → P0
        dims = self._dims(fact_hardness=3, lifecycle_impact=3, source_authority=2)
        self.assertEqual(assign_level(dims)[0], "P0")

    def test_p1_medium_hardness(self):
        dims = self._dims(fact_hardness=2, lifecycle_impact=1)
        self.assertEqual(assign_level(dims)[0], "P1")

    def test_p2_official_low_hardness(self):
        dims = self._dims(fact_hardness=0, source_authority=2)
        self.assertEqual(assign_level(dims)[0], "P2")

    def test_p3_low_authority_noise(self):
        dims = self._dims(fact_hardness=0, source_authority=1)
        self.assertEqual(assign_level(dims)[0], "P3")

    def test_score_orders_within_same_level(self):
        # 两个 dims 都落 P2，高分组 score 必须更大（同级内排序语义）
        lo = self._dims(source_authority=2, fact_hardness=0, novelty=0)
        hi = self._dims(source_authority=3, fact_hardness=1, novelty=2)
        self.assertEqual(assign_level(lo)[0], "P2")
        self.assertEqual(assign_level(hi)[0], "P2")
        self.assertGreater(assign_level(hi)[1], assign_level(lo)[1])

    def test_p0_needs_both_hardness_and_lifecycle(self):
        # 硬度 3 但生命周期 1（普通硬披露）→ 不够 P0，落 P1
        dims = self._dims(fact_hardness=3, lifecycle_impact=1)
        self.assertEqual(assign_level(dims)[0], "P1")


class TestScoreDimensions(unittest.TestCase):
    def test_returns_six_dims_in_range(self):
        r = _rec(source="inquiry", title="关于对瑞华泰的关注函", matched_keywords=["关注函"])
        dims = score_dimensions(r)
        self.assertEqual(set(dims), set(DIMENSIONS))
        for k in DIMENSIONS:
            self.assertTrue(0 <= dims[k] <= 3, f"{k}={dims[k]} 越界")

    def test_inquiry_fact_hardness_zero(self):
        # inquiry 源跳过 classify → fact_hardness 恒 0
        r = _rec(source="inquiry", title="关于对瑞华泰的关注函", matched_keywords=["关注函"])
        self.assertEqual(score_dimensions(r)["fact_hardness"], 0)


class TestTriageReverseEvidence(unittest.TestCase):
    def test_denial_with_anchor_forces_p0(self):
        # 答复里否认 + 命中题材关键词 → 强制 P0（与 classify 是否可用无关）
        r = _rec(
            source="irm_szse",
            title="是否涉及CoWoS",
            raw_excerpt="是否涉及CoWoS ||答复：公司在互动平台否认产品用于CoWoS",
            matched_keywords=["CoWoS"],
        )
        out = triage(r)
        self.assertEqual(out.triage_level, "P0")
        self.assertIsNotNone(out.triage_score)
        self.assertTrue(out.triage_score > 0)

    def test_interact_denial_without_keyword_still_p0(self):
        # 互动源天然带题材锚点：答复里否认即便无查询关键词也升 P0
        r = _rec(
            source="irm_szse",
            title="产品是否用于先进封装",
            raw_excerpt="产品是否用于先进封装 ||答复：公司澄清产品未用于先进封装",
        )
        self.assertEqual(triage(r).triage_level, "P0")

    def test_cninfo_denial_without_anchor_not_p0(self):
        # cninfo 公告 + 无关键词 + classify 无 fact_type：孤立「澄清」不知在澄清什么 → 不升 P0
        r = _rec(source="cninfo", title="关于媒体报道的澄清说明")
        self.assertNotEqual(triage(r).triage_level, "P0")

    def test_boilerplate_not_treated_as_reverse(self):
        # 答复里年报套话「不存在应披露而未披露」不应触发反证升级
        r = _rec(source="irm_szse", title="提问",
                 raw_excerpt="提问 ||答复：公司称不存在应披露而未披露的重大事项")
        out = triage(r)
        # 互动源有锚点，但 detect_negation 因套话抑制返回 None → 不强制 P0
        self.assertNotEqual(out.triage_level, "P0")

    def test_inquiry_letter_is_p2(self):
        # 问询函本身：硬度 0 + 权威 3 → P2（仅缓存，不丢弃）
        r = _rec(source="inquiry", title="关于对瑞华泰的关注函", matched_keywords=["关注函"])
        self.assertEqual(triage(r).triage_level, "P2")

    def test_triage_is_idempotent(self):
        r = _rec(
            source="irm_szse", title="是否涉及CoWoS", matched_keywords=["CoWoS"],
            raw_excerpt="是否涉及CoWoS ||答复：公司否认产品用于CoWoS",
        )
        triage(r)
        lvl1, sc1 = r.triage_level, r.triage_score
        triage(r)  # 再跑一次
        self.assertEqual((r.triage_level, r.triage_score), (lvl1, sc1))


class TestDetectNegation(unittest.TestCase):
    def test_hits_strong_denial(self):
        self.assertEqual(detect_negation("公司否认涉及该业务"), "否认")
        self.assertEqual(detect_negation("传闻不实"), "传闻不实")

    def test_misses_plain_title(self):
        self.assertIsNone(detect_negation("签订重大合同"))

    def test_boilerplate_suppressed(self):
        # 合规套话抑制：无强否认词时不算反证
        self.assertIsNone(detect_negation("不存在应披露而未披露的重大事项"))

    def test_strong_overrides_boilerplate(self):
        # 强否认词覆盖套话：套话里若同时含「否认」仍算反证
        self.assertIsNotNone(detect_negation("应披露而未披露...公司否认相关传闻"))


class TestNoiseRouting(unittest.TestCase):
    """cninfo exclude_any 噪音 → P3（对齐 DESIGN §8；修 handoff §6 的口径偏差）。"""

    def test_is_noise_pure(self):
        excl = ["董事会决议", "问询函", "担保"]
        self.assertTrue(_is_noise("第三届董事会决议公告", excl))
        self.assertFalse(_is_noise("关于签订重大合同的公告", excl))

    @unittest.skipIf(not _HAVE_CNINFO_CFG, "需 PyYAML + cninfo-rss/config.yaml")
    def test_cninfo_noise_routed_to_p3(self):
        r = _rec(source="cninfo", title="董事会决议公告")
        self.assertEqual(triage(r).triage_level, "P3")

    @unittest.skipIf(not _HAVE_CNINFO_CFG, "需 PyYAML + cninfo-rss/config.yaml")
    def test_hard_fact_not_noise(self):
        # 同为 cninfo，但标题命中 include_any（硬事实）→ P0，不被噪音规则压成 P3
        r = _rec(source="cninfo", title="关于签订重大合同的公告")
        self.assertEqual(triage(r).triage_level, "P0")

    @unittest.skipIf(not _HAVE_CNINFO_CFG, "需 PyYAML + cninfo-rss/config.yaml")
    def test_reverse_evidence_beats_noise(self):
        # 反证优先级高于噪音：即便标题沾 exclude_any，强否认 + 锚点仍 P0
        # （互动源天然带锚点，且 exclude_any 仅对 cninfo 生效——这里用 cninfo + 关键词锚点验证）
        r = _rec(
            source="cninfo",
            title="关于媒体报道的澄清：公司否认相关传闻",
            matched_keywords=["传闻"],
        )
        self.assertEqual(triage(r).triage_level, "P0")


class TestProductProgress(unittest.TestCase):
    """Gap A：互动软进展词 → P1；否定前缀(未/尚未)不误升；inquiry 不套。"""

    def test_detect_progress_pure(self):
        self.assertEqual(_detect_product_progress("公司已送样"), ("customer_validation", True))
        self.assertEqual(_detect_product_progress("尚未送样"), (None, False))
        self.assertEqual(_detect_product_progress("未送样"), (None, False))
        self.assertEqual(_detect_product_progress("签订重大合同"), (None, False))

    def test_songyang_to_p1(self):
        r = _rec(source="irm_szse", title="送样进展",
                 raw_excerpt="送样进展 ||答复：公司已向客户送样")
        self.assertEqual(triage(r).triage_level, "P1")

    def test_xiaopiliang_to_p1(self):
        r = _rec(source="irm_szse", title="量产进展",
                 raw_excerpt="量产进展 ||答复：新产品已小批量生产")
        self.assertEqual(triage(r).triage_level, "P1")

    def test_xingchengshouru_to_p1(self):
        r = _rec(source="irm_szse", title="收入情况",
                 raw_excerpt="收入情况 ||答复：相关产品已形成收入")
        self.assertEqual(triage(r).triage_level, "P1")

    def test_negated_progress_not_p1(self):
        # 答复「尚未送样」不当正向进展 → 不升 P1
        r = _rec(source="irm_szse", title="送样进展",
                 raw_excerpt="送样进展 ||答复：公司称尚未送样")
        self.assertNotEqual(triage(r).triage_level, "P1")

    def test_progress_cninfo_also_p1(self):
        # cninfo 标题含送样（classify 不认）→ 同样进 P1
        r = _rec(source="cninfo", title="关于新产品送样客户的公告")
        self.assertEqual(triage(r).triage_level, "P1")

    def test_progress_denial_is_p0(self):
        # 答复否认送样 → 反证 P0（否认词覆盖进展词）
        r = _rec(source="irm_szse", title="送样情况",
                 raw_excerpt="送样情况 ||答复：公司否认已向客户送样")
        self.assertEqual(triage(r).triage_level, "P0")

    def test_inquiry_skips_progress(self):
        # inquiry 源不套进展词表（与跳过 classify 一致）
        r = _rec(source="inquiry", title="关于公司送样情况的关注函", matched_keywords=["关注函"])
        self.assertNotEqual(triage(r).triage_level, "P1")


class TestClassifyNegation(unittest.TestCase):
    """§5.8：classify 命中词被时态否定前缀修饰(尚未/未) → 降 review(不假 P0)；
    断言性否认(否认/并未)仍走 detect_negation → P0 反证。"""

    def test_keyword_negated_pure(self):
        self.assertTrue(_keyword_negated("尚未量产", "keyword:量产"))
        self.assertTrue(_keyword_negated("公司称未投产", "keyword:投产"))
        self.assertFalse(_keyword_negated("新产品量产", "keyword:量产"))
        self.assertFalse(_keyword_negated("签订重大合同", "keyword:重大合同"))
        self.assertFalse(_keyword_negated("xxx", "category:股权变动"))

    @unittest.skipIf(not _HAVE_CNINFO_CFG, "需 PyYAML + cninfo-rss/config.yaml")
    def test_temporal_negation_not_p0(self):
        # 「尚未量产」：时态性否定 → 降 review，不假 P0
        r = _rec(source="cninfo", title="公司产品尚未量产")
        self.assertNotEqual(triage(r).triage_level, "P0")

    @unittest.skipIf(not _HAVE_CNINFO_CFG, "需 PyYAML + cninfo-rss/config.yaml")
    def test_bare_wei_negation_not_p0(self):
        r = _rec(source="cninfo", title="项目未投产")
        self.assertNotEqual(triage(r).triage_level, "P0")

    @unittest.skipIf(not _HAVE_CNINFO_CFG, "需 PyYAML + cninfo-rss/config.yaml")
    def test_positive_hard_fact_still_p0(self):
        # 无否定前缀的正向硬词仍是 P0（回归）
        r = _rec(source="cninfo", title="新产品正式量产的公告")
        self.assertEqual(triage(r).triage_level, "P0")

    @unittest.skipIf(not _HAVE_CNINFO_CFG, "需 PyYAML + cninfo-rss/config.yaml")
    def test_categorial_denial_is_p0(self):
        # 「否认」断言性否认 → P0 反证（detect_negation 路径，区别于时态降级）
        r = _rec(source="cninfo", title="公司否认产品已量产")
        self.assertEqual(triage(r).triage_level, "P0")


class TestInteractAnswerAware(unittest.TestCase):
    """Gap B：互动源只对答复正文做事实抽取；提问里的词不当事实。"""

    def test_question_keyword_not_treated_as_fact(self):
        # 投资者建议回购（在提问里），答复无回购 → 不升 P0（修前是假 P0）
        r = _rec(
            source="irm_szse",
            title="建议公司回购",
            raw_excerpt="建议公司适当回购  ||答复：感谢您的建议和关注",
        )
        self.assertNotEqual(triage(r).triage_level, "P0")

    def test_answer_progress_to_p1(self):
        r = _rec(
            source="irm_szse",
            title="固态电池何时量产",
            raw_excerpt="固态电池何时量产 ||答复：2027年有望实现小批量生产",
        )
        self.assertEqual(triage(r).triage_level, "P1")

    def test_answer_denial_to_p0(self):
        r = _rec(
            source="irm_szse",
            title="是否涉及CoWoS",
            raw_excerpt="是否涉及CoWoS ||答复：公司未涉及CoWoS相关业务",
        )
        self.assertEqual(triage(r).triage_level, "P0")

    def test_unanswered_question_is_p2(self):
        # 纯提问（无答复），提问含「量产」也不当事实 → P2（修前是假 P0）
        r = _rec(
            source="irm_szse",
            title="固液混合电池何时量产装车",
            raw_excerpt="固液混合电池何时量产装车",
        )
        self.assertNotEqual(triage(r).triage_level, "P0")

    def test_cninfo_uses_full_title(self):
        # 公告源不受互动改动影响：标题含硬词 → P0（回归）
        r = _rec(source="cninfo", title="关于签订重大合同的公告",
                 raw_excerpt="关于签订重大合同的公告")
        self.assertEqual(triage(r).triage_level, "P0")


if __name__ == "__main__":
    unittest.main()
