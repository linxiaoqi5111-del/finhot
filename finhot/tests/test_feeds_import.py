"""feeds.json/OPML 导入单测：OPML 递归解析、多形态 JSON、URL 去重、合并不丢现有、dry-run。

运行：在 finhot/ 目录下 `python -m unittest discover -s tests`
"""
import json
import os
import tempfile
import unittest

from app import feeds_import as fi


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def _load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


_OPML = """<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>My Feeds</title></head>
  <body>
    <outline text="科技" title="科技">
      <outline type="rss" text="36氪" title="36氪" xmlUrl="https://36kr.com/feed" htmlUrl="https://36kr.com"/>
      <outline type="rss" text="钛媒体" xmlUrl="https://www.tmtpost.com/feed"/>
    </outline>
    <outline type="rss" text="少数派" xmlUrl="https://sspai.com/feed"/>
  </body>
</opml>"""


class ParseOpmlTest(unittest.TestCase):
    def test_collects_nested_xmlurls(self):
        feeds = fi.parse_opml(_OPML)
        urls = [f["url"] for f in feeds]
        self.assertEqual(urls, ["https://36kr.com/feed", "https://www.tmtpost.com/feed", "https://sspai.com/feed"])

    def test_name_from_text_attr(self):
        feeds = fi.parse_opml(_OPML)
        self.assertEqual(feeds[0]["name"], "36氪")

    def test_category_outline_without_xmlurl_skipped(self):
        feeds = fi.parse_opml(_OPML)
        self.assertNotIn("科技", [f["name"] for f in feeds])


class ParseJsonTest(unittest.TestCase):
    def test_native_list(self):
        feeds = fi.parse_feeds_json(json.dumps([{"name": "A", "url": "https://a.com/feed"}]))
        self.assertEqual(feeds, [{"name": "A", "url": "https://a.com/feed"}])

    def test_watchlist_shape(self):
        feeds = fi.parse_feeds_json(json.dumps({"rss": [{"name": "B", "url": "https://b.com/rss"}], "weibo": []}))
        self.assertEqual(feeds, [{"name": "B", "url": "https://b.com/rss"}])

    def test_opml_json_shape(self):
        feeds = fi.parse_feeds_json(json.dumps([{"title": "C", "xmlUrl": "https://c.com/feed"}]))
        self.assertEqual(feeds, [{"name": "C", "url": "https://c.com/feed"}])

    def test_name_to_url_map(self):
        feeds = fi.parse_feeds_json(json.dumps({"36氪": "https://36kr.com/feed"}))
        self.assertEqual(feeds, [{"name": "36氪", "url": "https://36kr.com/feed"}])

    def test_name_falls_back_to_host(self):
        feeds = fi.parse_feeds_json(json.dumps([{"url": "https://www.example.com/feed"}]))
        self.assertEqual(feeds[0]["name"], "example.com")


class DedupMergeTest(unittest.TestCase):
    def test_dedup_within_file(self):
        feeds = fi.dedup([
            {"name": "A", "url": "https://a.com/feed"},
            {"name": "A2", "url": "https://a.com/feed/"},  # 仅尾斜杠不同
        ])
        self.assertEqual(len(feeds), 1)

    def test_merge_skips_existing_and_keeps_them(self):
        wl = {"weibo": ["123"], "rss": [{"name": "老源", "url": "https://old.com/feed"}]}
        feeds = [
            {"name": "老源repeat", "url": "https://old.com/feed/"},  # 已存在（尾斜杠）
            {"name": "新源", "url": "https://new.com/feed"},
        ]
        new_wl, added, skipped = fi.merge_rss(wl, feeds)
        self.assertEqual([f["name"] for f in added], ["新源"])
        self.assertEqual(len(skipped), 1)
        # 现有源与其他键保留
        self.assertEqual(new_wl["weibo"], ["123"])
        rss_urls = {e["url"] for e in new_wl["rss"]}
        self.assertEqual(rss_urls, {"https://old.com/feed", "https://new.com/feed"})


class ImportFilesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.opml = os.path.join(self.tmp, "feeds.opml")
        with open(self.opml, "w", encoding="utf-8") as f:
            f.write(_OPML)
        self.wl = os.path.join(self.tmp, "watchlist.json")
        with open(self.wl, "w", encoding="utf-8") as f:
            json.dump({"weibo": [], "rss": [{"name": "36氪", "url": "https://36kr.com/feed"}]}, f)

    def test_dry_run_does_not_write(self):
        before = _read(self.wl)
        added, skipped = fi.import_files([self.opml], watchlist_path=self.wl, dry_run=True)
        self.assertEqual(_read(self.wl), before)
        self.assertEqual(len(added), 2)   # 钛媒体 + 少数派（36氪 已存在被跳过）
        self.assertEqual(len(skipped), 1)

    def test_writes_merged_watchlist(self):
        fi.import_files([self.opml], watchlist_path=self.wl, dry_run=False)
        wl = _load(self.wl)
        urls = {e["url"] for e in wl["rss"]}
        self.assertEqual(urls, {
            "https://36kr.com/feed", "https://www.tmtpost.com/feed", "https://sspai.com/feed",
        })
        self.assertIn("weibo", wl)  # 其他键不丢

    def test_sniff_extensionless(self):
        p = os.path.join(self.tmp, "noext")
        with open(p, "w", encoding="utf-8") as f:
            f.write(_OPML)
        feeds = fi.parse_feeds_file(p)
        self.assertEqual(len(feeds), 3)


if __name__ == "__main__":
    unittest.main()
