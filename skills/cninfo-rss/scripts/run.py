#!/usr/bin/env python3
"""单入口：fetch → 去重 → RSS → (apply) 归档 L3 → 更新水位。

用法：
    python3 skills/cninfo-rss/scripts/run.py --dry-run     # 不写归档/不动水位
    python3 skills/cninfo-rss/scripts/run.py --apply       # 全量执行

dry-run 与 apply 都会重写 feeds/（feed 每次按当前窗口全量重生成，幂等、已 gitignore）；
区别在于 apply 才写 knowledge-base 归档并推进 state.json 增量水位。
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fetch_cninfo as fc  # noqa: E402
import emit_rss  # noqa: E402
import archive_l3  # noqa: E402
import state as state_mod  # noqa: E402


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="巨潮公告分类订阅器")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="不写归档、不动水位")
    mode.add_argument("--apply", action="store_true", help="写归档 + 更新水位")
    ap.add_argument("--config", default=None, help="config.yaml 路径")
    ap.add_argument("--rss-dir", default=None, help="覆盖 output.rss_dir")
    ap.add_argument("--kb-dir", default=None, help="覆盖 output.kb_archive_dir")
    ap.add_argument("--lookback-days", type=int, default=None)
    ap.add_argument("--limit", type=int, default=None, help="覆盖 max_pages_per_source")
    ap.add_argument("--sample", type=int, default=8, help="stdout 打印的样本条数")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    cfg = fc.load_config(args.config)
    if args.lookback_days is not None:
        cfg["lookback_days"] = args.lookback_days
    if args.limit is not None:
        cfg["max_pages_per_source"] = args.limit

    out = cfg.get("output", {}) or {}
    rss_dir = fc.resolve_path(args.rss_dir or out.get("rss_dir", "skills/cninfo-rss/feeds"))
    kb_dir = fc.resolve_path(args.kb_dir or out.get("kb_archive_dir", "../knowledge-base-private/wiki/raw/disclosures"))
    state_path = Path(rss_dir) / "state.json"

    apply = bool(args.apply)
    batch_id = datetime.now(fc.CN_TZ).strftime("%Y%m%d-%H%M%S")

    # 1) 抓取 + 过滤 + 分类
    fetched = fc.collect(cfg)

    # 2) 增量去重（apply 模式才依据持久化水位；dry-run 也读，但不写回）
    st = state_mod.load_state(state_path)
    new_records = state_mod.filter_new(fetched, st)

    # 3) RSS（feed 每次全量重生成，用 fetched 而非 new，保证 feed 完整）
    written = emit_rss.write_feeds(fetched, rss_dir, cfg)
    rss_total = sum(written.values())

    # 4) 归档 L3（apply 才落盘；dry-run 走统计）。归档用「新」记录避免重复归档。
    arch_input = new_records if apply else fetched
    arch_stats = archive_l3.archive_records(arch_input, kb_dir, batch_id, apply=apply)

    # 5) 更新水位（仅 apply）
    if apply:
        state_mod.update_state(st, fetched)
        state_mod.save_state(state_path, st)

    l3_hard = sum(1 for r in fetched if r.get("update_type") == "hard_delta")
    l3_review = sum(1 for r in fetched if r.get("update_type") == "review_candidate")

    # ---- 摘要 ----
    print("=" * 60)
    print(f"mode          : {'apply' if apply else 'dry-run'}")
    print(f"batch_id      : {batch_id}")
    print(f"lookback_days : {cfg.get('lookback_days')}  markets={cfg.get('markets')}  watchlist={cfg.get('watchlist_codes') or '全市场'}")
    print(f"fetched(L3)   : {len(fetched)}")
    print(f"new(去重后)   : {len(new_records)}")
    print(f"l3_hard       : {l3_hard}")
    print(f"l3_review     : {l3_review}")
    print(f"rss_written   : {rss_total} 条 / {len(written)} 个 feed")
    for p, c in written.items():
        print(f"    - {p}  ({c})")
    print(f"archive       : md={arch_stats['archived_md']} manifest={arch_stats['manifest_lines']} review_queue={arch_stats['review_queue']}  -> {kb_dir}")
    if not apply:
        print("  (dry-run：未写 knowledge-base 归档、未推进 state.json)")
    print("-" * 60)
    print(f"样本（最近 {args.sample} 条）：")
    for r in fetched[: args.sample]:
        print(f"  [{r['update_type']:>16}] {r['published_at'][:16]} {r['sec_name']}({r['sec_code']}) "
              f"{r['fact_type']} | {r['title'][:40]}  <{r['l3_match_reason']}>")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
