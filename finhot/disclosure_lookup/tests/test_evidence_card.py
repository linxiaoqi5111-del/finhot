"""证据卡离线单测（from_record / to_yaml / write_candidate / generate_candidates）。

运行（cwd = finhot/finhot）：
    python3 -m unittest disclosure_lookup.tests.test_evidence_card -v
"""
import tempfile
import unittest
from pathlib import Path

from disclosure_lookup.evidence_card import (
    from_record,
    generate_candidates,
    resolve_kb_dir,
    to_yaml,
    write_candidate,
)
from disclosure_lookup.schema import DisclosureRecord
from disclosure_lookup.triage import triage

try:
    import yaml  # noqa: F401

    _HAVE_YAML = True
except ImportError:
    _HAVE_YAML = False


def _rec(**kw) -> DisclosureRecord:
    base = dict(
        company_name="瑞华泰",
        company_code="688323",
        source="cninfo",
        title="",
        url="https://example/cninfo",
        published_at="2026-06-30T00:00:00+08:00",
    )
    base.update(kw)
    return DisclosureRecord(**base)


class TestFromRecord(unittest.TestCase):
    def test_p0_hard_fact_candidate(self):
        r = _rec(source="cninfo", title="关于签订重大合同的公告")
        r.triage_level, r.fact_type = "P0", "order_contract"
        card = from_record(r)
        self.assertEqual(card.evidence_layer, "L1_L3_candidate")  # 未下 PDF，上限即候选
        self.assertEqual(card.confidence, "high")
        self.assertEqual(card.fact_type, "order_contract")
        self.assertEqual(card.source_type, "巨潮公告")
        self.assertEqual(card.review_status, "pending")

    def test_reverse_evidence_is_l3_negative(self):
        r = _rec(
            source="irm_szse",
            title="是否涉及CoWoS",
            raw_excerpt="是否涉及CoWoS ||答复：公司在互动平台否认产品用于CoWoS",
            matched_keywords=["CoWoS"],
        )
        triage(r)
        self.assertEqual(r.triage_level, "P0")
        card = from_record(r)
        self.assertEqual(card.evidence_layer, "L3_negative")
        self.assertEqual(card.confidence, "high")
        self.assertIn("反证", card.lifecycle_impact)
        self.assertEqual(card.source_type, "互动易(深)")

    def test_p1_progress_candidate(self):
        r = _rec(source="irm_szse", title="送样进展",
                 raw_excerpt="送样进展 ||答复：公司已向客户送样")
        triage(r)
        self.assertEqual(r.triage_level, "P1")
        card = from_record(r)
        self.assertEqual(card.evidence_layer, "L1_L3_candidate")
        self.assertEqual(card.confidence, "medium")  # P1 复核桶
        self.assertEqual(card.triage_level, "P1")

    def test_theme_links_from_matched(self):
        r = _rec(source="irm_szse", title="公司否认用于CoWoS", matched_keywords=["CoWoS", "先进封装"])
        triage(r)
        card = from_record(r)
        self.assertEqual(card.theme_links, ["CoWoS", "先进封装"])


class TestYamlAndWrite(unittest.TestCase):
    @unittest.skipIf(not _HAVE_YAML, "需 PyYAML")
    def test_to_yaml_roundtrip(self):
        r = _rec(source="irm_szse", title="是否涉及CoWoS",
                 raw_excerpt="是否涉及CoWoS ||答复：公司否认产品用于CoWoS",
                 matched_keywords=["CoWoS"])
        triage(r)
        s = to_yaml(from_record(r))
        self.assertIn("L3_negative", s)
        self.assertIn("evidence_layer:", s)
        parsed = yaml.safe_load(s)
        self.assertEqual(parsed["evidence_layer"], "L3_negative")
        self.assertEqual(parsed["company"], "瑞华泰")

    @unittest.skipIf(not _HAVE_YAML, "需 PyYAML")
    def test_write_candidate_stable_filename(self):
        r = _rec(source="irm_szse", title="公司否认产品用于CoWoS", matched_keywords=["CoWoS"])
        triage(r)
        card = from_record(r)
        with tempfile.TemporaryDirectory() as td:
            p1 = write_candidate(card, Path(td))
            p2 = write_candidate(card, Path(td))  # 同 fact → 同文件名（去重）
            self.assertEqual(p1, p2)
            self.assertTrue(p1.exists())
            self.assertEqual(p1.suffix, ".yaml")

    @unittest.skipIf(not _HAVE_YAML, "需 PyYAML")
    def test_generate_filters_p0_p1(self):
        recs = []
        r1 = _rec(source="irm_szse", title="是否涉及CoWoS",
                  raw_excerpt="是否涉及CoWoS ||答复：公司否认产品用于CoWoS",
                  matched_keywords=["CoWoS"])
        r2 = _rec(source="irm_szse", title="送样进展",
                  raw_excerpt="送样进展 ||答复：公司已向客户送样")
        r3 = _rec(source="irm_szse", title="公司日常经营情况正常")  # → P2，跳过
        for r in (r1, r2, r3):
            triage(r)
            recs.append(r)
        self.assertEqual(r3.triage_level, "P2")
        with tempfile.TemporaryDirectory() as td:
            paths = generate_candidates(recs, kb_dir=Path(td))
            self.assertEqual(len(paths), 2)  # 只生成 P0 + P1
            for p in paths:
                self.assertTrue(p.exists())


class TestResolveKbDir(unittest.TestCase):
    def test_default_when_no_config(self):
        p = resolve_kb_dir(None)
        self.assertTrue(p.is_absolute())
        self.assertIn("disclosures", str(p))

    def test_respects_config_relative(self):
        # 相对路径相对 disclosure_lookup 目录解析
        p = resolve_kb_dir({"evidence_card": {"kb_dir": "../../tmp_kb"}})
        self.assertEqual(p.name, "tmp_kb")

    def test_absolute_passthrough(self):
        p = resolve_kb_dir({"evidence_card": {"kb_dir": "/tmp/abs_kb"}})
        self.assertEqual(str(p), "/tmp/abs_kb")


if __name__ == "__main__":
    unittest.main()
