"""把 OPML / feeds.json 里的 RSS 源批量导入 watchlist.json 的 "rss" 列表。

绝大多数 RSS 阅读器（Feedly/Inoreader/FreshRSS…）都能导出 OPML，订阅迁移到 finhot
只需一条命令。导入按 URL 去重（文件内重复、与现有 watchlist 重复都跳过），支持 --dry-run
预览不落盘。

用法：
    python -m app.feeds_import feeds.opml              # 合并进默认 watchlist.json
    python -m app.feeds_import feeds.opml --dry-run    # 只预览不写
    python -m app.feeds_import feeds.json --out wl.json
    python -m app.feeds_import a.opml b.json           # 多个文件一起导入

支持的输入格式：
  · .opml / .xml：标准 OPML，递归收集所有带 xmlUrl 的 <outline>
  · .json：以下任一形态
      - [{"name": .., "url": ..}, ...]              # finhot 原生
      - {"rss": [{"name":..,"url":..}, ...], ...}    # 整个 watchlist.json
      - [{"title":..,"xmlUrl":..}, ...]              # OPML 转的 JSON
      - {"36氪": "https://36kr.com/feed", ...}        # 名称 -> URL 映射
"""
import argparse
import json
import os
import xml.etree.ElementTree as ET
from urllib.parse import urlparse

WATCHLIST_PATH = os.path.join(os.path.dirname(__file__), "..", "watchlist.json")


def _name_from_url(url):
    host = urlparse(url).netloc or url
    return host[4:] if host.startswith("www.") else host


def _norm(url):
    """URL 归一化用于去重：去首尾空白、去结尾斜杠。"""
    return (url or "").strip().rstrip("/")


def parse_opml(text):
    """OPML 文本 -> [{"name","url"}]，递归收集所有带 xmlUrl 的 outline。"""
    root = ET.fromstring(text)
    feeds = []
    for outline in root.iter("outline"):
        url = (outline.get("xmlUrl") or outline.get("xmlurl") or "").strip()
        if not url:
            continue
        name = (outline.get("text") or outline.get("title") or _name_from_url(url)).strip()
        feeds.append({"name": name, "url": url})
    return feeds


def parse_feeds_json(text):
    """feeds.json 文本（多种形态）-> [{"name","url"}]。"""
    data = json.loads(text)
    raw = []
    if isinstance(data, dict):
        if isinstance(data.get("rss"), list):
            raw = data["rss"]
        else:  # 名称 -> URL 映射
            raw = [{"name": k, "url": v} for k, v in data.items()
                   if isinstance(v, str) and v.startswith("http")]
    elif isinstance(data, list):
        raw = data
    feeds = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        url = (entry.get("url") or entry.get("xmlUrl") or entry.get("xmlurl") or "").strip()
        if not url:
            continue
        name = (entry.get("name") or entry.get("title") or entry.get("text") or _name_from_url(url)).strip()
        feeds.append({"name": name, "url": url})
    return feeds


def parse_feeds_file(path):
    """按扩展名/内容选择解析器。"""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    ext = os.path.splitext(path)[1].lower()
    if ext in (".opml", ".xml"):
        return parse_opml(text)
    if ext == ".json":
        return parse_feeds_json(text)
    # 未知扩展名：按内容嗅探
    stripped = text.lstrip()
    if stripped.startswith("<"):
        return parse_opml(text)
    return parse_feeds_json(text)


def dedup(feeds):
    """文件内按 URL 去重，保留首次出现。"""
    seen = set()
    out = []
    for f in feeds:
        key = _norm(f["url"])
        if key and key not in seen:
            seen.add(key)
            out.append(f)
    return out


def load_watchlist(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def merge_rss(watchlist, feeds):
    """把 feeds 合并进 watchlist 的 "rss"（按 URL 去重）。返回 (新 watchlist, added, skipped)。"""
    wl = dict(watchlist)
    existing = list(wl.get("rss") or [])
    existing_urls = {_norm(e.get("url", "")) for e in existing if isinstance(e, dict)}
    added, skipped = [], []
    for f in dedup(feeds):
        if _norm(f["url"]) in existing_urls:
            skipped.append(f)
            continue
        existing.append({"name": f["name"], "url": f["url"]})
        existing_urls.add(_norm(f["url"]))
        added.append(f)
    wl["rss"] = existing
    return wl, added, skipped


def import_files(paths, watchlist_path=WATCHLIST_PATH, dry_run=False):
    """主流程：解析多个文件 -> 合并 -> （非 dry-run 时）写回。返回 (added, skipped)。"""
    feeds = []
    for p in paths:
        feeds.extend(parse_feeds_file(p))
    watchlist = load_watchlist(watchlist_path)
    new_wl, added, skipped = merge_rss(watchlist, feeds)
    if not dry_run:
        with open(watchlist_path, "w", encoding="utf-8") as f:
            json.dump(new_wl, f, ensure_ascii=False, indent=2)
    return added, skipped


def main():
    parser = argparse.ArgumentParser(description="导入 OPML/feeds.json 的 RSS 源到 watchlist.json")
    parser.add_argument("files", nargs="+", help="OPML(.opml/.xml) 或 feeds.json 文件，可多个")
    parser.add_argument("--out", default=WATCHLIST_PATH, help="目标 watchlist.json（默认 finhot/watchlist.json）")
    parser.add_argument("--dry-run", action="store_true", help="只预览不写盘")
    args = parser.parse_args()
    added, skipped = import_files(args.files, watchlist_path=args.out, dry_run=args.dry_run)
    tag = "[dry-run] " if args.dry_run else ""
    print(f"{tag}新增 {len(added)} 个，跳过 {len(skipped)} 个（重复）-> {args.out}")
    for f in added:
        print(f"  + {f['name']}  {f['url']}")
    if skipped:
        print(f"  跳过重复 {len(skipped)} 个")


if __name__ == "__main__":
    main()
