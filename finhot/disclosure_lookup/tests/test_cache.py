"""cache-aside 原语测试：put_records 水位 TTL（含负缓存短 TTL）。

运行（cwd = finhot/finhot）：
    python3 -m unittest disclosure_lookup.tests.test_cache -v
"""
import tempfile
import unittest
from pathlib import Path

from disclosure_lookup import cache
from disclosure_lookup.cache import _now, _parse
from disclosure_lookup.schema import DisclosureRecord


class TestWatermarkTtl(unittest.TestCase):
    def _watermark_delta(self, conn, query_key):
        row = conn.execute(
            "SELECT ttl_expires_at FROM query_watermark WHERE query_key = ?", (query_key,)
        ).fetchone()
        self.assertIsNotNone(row, "水位未写入")
        return (_parse(row["ttl_expires_at"]) - _now()).total_seconds()

    def test_empty_records_short_watermark(self):
        # 负缓存：空记录 + ttl_days=1 → 水位 ~1 天后过期（不是 7 天）
        with tempfile.TemporaryDirectory() as td:
            conn = cache.connect(Path(td) / "t.sqlite")
            try:
                cache.put_records(conn, [], query_key="src:code:30d", ttl_days=1)
                delta = self._watermark_delta(conn, "src:code:30d")
                self.assertTrue(80000 < delta < 90000, f"空水位 ttl={delta}s 不是 ~1 天")
            finally:
                conn.close()

    def test_nonempty_records_normal_watermark(self):
        # 非空 + ttl_days=7 → 水位 ~7 天
        with tempfile.TemporaryDirectory() as td:
            conn = cache.connect(Path(td) / "t.sqlite")
            try:
                r = DisclosureRecord(
                    company_name="X", company_code="001", source="cninfo",
                    title="签订重大合同", url="", published_at="2026-06-30T00:00:00+08:00",
                )
                cache.put_records(conn, [r], query_key="k", ttl_days=7)
                delta = self._watermark_delta(conn, "k")
                self.assertTrue(6 * 86400 < delta < 7 * 86400, f"水位 ttl={delta}s 不是 ~7 天")
            finally:
                conn.close()

    def test_empty_no_record_rows(self):
        # 空记录不应往 disclosure_cache 写行（只有水位）
        with tempfile.TemporaryDirectory() as td:
            conn = cache.connect(Path(td) / "t.sqlite")
            try:
                cache.put_records(conn, [], query_key="k", ttl_days=1)
                n = conn.execute("SELECT COUNT(*) FROM disclosure_cache").fetchone()[0]
                self.assertEqual(n, 0)
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
