---
name: cninfo-rss
description: 可配置的巨潮公告分类订阅器：按分类+关键词+自选股抓取全市场披露，输出标准 Atom RSS，并把 L3 硬事实归档到知识库 wiki/raw/disclosures 补证据缺口。触发：巨潮RSS、公告订阅、cninfo rss、补L3公告。
---

# cninfo-rss · 巨潮公告分类订阅 + L3 证据补库

按指定**公告类别 + 标题关键词 + 自选股范围**抓取全市场披露 →
输出标准 **Atom RSS**（任意阅读器可订阅）+ 把符合 **L3 硬事实**的公告归档到
`knowledge-base-private/wiki/raw/disclosures/`，弥补 L3 官方证据缺口。

**不是** FinHot 替代品；**不**默认写 `entities/` 正文；**不**把研报二手事实当 L3。

## 触发词
`巨潮RSS` · `公告订阅` · `cninfo rss` · `补L3公告`

## L3 边界（硬规则）

| 层级 | 含义 | 本 skill |
|------|------|----------|
| L2 | 公司画像 / 定期报告 baseline | 不处理 |
| **L3** | 公告/订单/合同/中标/认证/量产/投产/增减持/激励/重组 | **处理** |
| L4 | 盘面/媒体弱信号 | 不处理 |
| L1_L3_candidate | 卖方研报二手事实 | 不处理 |

- 命中 `exclude_any`（董事会决议/核查意见/理财…）→ 直接丢弃（优先级最高）。
- 命中**分类码**或 `include_any` 标题词 → `evidence_layer=L3`。
- 标题含低确定性词（拟/计划/预计/有望/框架协议…）→ 降级
  `update_type=review_candidate` + `confidence=low`，**不进 entity 正文**。
- 其余 → `update_type=hard_delta` + `confidence=high`。

## 架构（三层，可独立运行）

```
cninfo 直连 API（hisAnnouncement/query，POST，不依赖公共 RSSHub）
   ↓ fetch_cninfo.py：分类码 + searchkey 关键词 + 自选股(stock) 抓取
   ↓ 归一化 + 去重(announcement_id) + 市场/关键词过滤 + L3 分类
┌────────────────────────┬──────────────────────────────┐
│ A. RSS 输出             │ B. 知识库 L3 归档             │
│ emit_rss.py → feeds/*.xml│ archive_l3.py → wiki/raw/...  │
│ state.py 增量水位        │ manifest.jsonl + review-queue │
└────────────────────────┴──────────────────────────────┘
   ↓（可选）C. FinHot / 任意 RSS 阅读器订阅 feeds/*.xml
```

为什么直连 cninfo 而非 RSSHub：`rsshub.app` 常 403/503，本机 RSSHub 无 cninfo 路由；
直连 API 字段全（announcementId 做稳定去重键）、可按 category/searchkey 精确过滤。

## 用法

```bash
# 手动（先 dry-run 看真实样本，不写归档、不动水位）
python3 skills/cninfo-rss/scripts/run.py --dry-run

# 全量执行：写 feeds + 归档 L3 到 knowledge-base + 推进 state.json
python3 skills/cninfo-rss/scripts/run.py --apply

# 常用覆盖项
python3 skills/cninfo-rss/scripts/run.py --dry-run --limit 3 --lookback-days 3
python3 skills/cninfo-rss/scripts/run.py --apply --kb-dir /abs/path/disclosures

# 单测（离线，无网络）
python3 -m unittest discover -s skills/cninfo-rss/tests
```

dry-run 与 apply 都会重写 `feeds/*.xml`（feed 每次按窗口全量重生成，幂等）；
区别：apply 才写知识库归档并推进增量水位。

## 配置（`config.yaml`）

| 键 | 说明 |
|----|------|
| `lookback_days` | seDate 回看天数（默认 7） |
| `markets` | 保留市场 `szse/sse/bj`，按 code 前缀判定 |
| `watchlist_codes` | 空=全市场；非空=只保留这些代码（并走 stock 精确查询） |
| `max_pages_per_source` | 每分类/关键词最多翻页数（控时长 + 防封） |
| `rate_limit_seconds` | 串行请求间隔 |
| `output.rss_dir` / `output.kb_archive_dir` | RSS / 归档落点（相对路径相对仓库根） |
| `l3_categories` | 巨潮分类码 + fact_types + enabled |
| `l3_title_keywords.include_any/exclude_any` | 关键词命中/排除 |
| `low_confidence_keywords` | 触发降级为 review_candidate |
| `fact_type_by_keyword` | 关键词 → fact_type 映射 |

## 输出

- `feeds/l3-hard-delta.xml` — 全市场 L3 硬事实合集（hard_delta）
- `feeds/by-category/{code}.xml` — 每个订阅分类一份（hard + review）
- `feeds/watchlist.xml` — 仅 `watchlist_codes`（为空时镜像全部）
- `feeds/state.json` — 增量去重水位（seen_ids + high_water_ms）
- 知识库归档（仅 --apply）：
  - `wiki/raw/disclosures/YYYY-MM-DD/cninfo_{code}_{id}_{slug}.md`（仅 hard_delta+high）
  - `manifest.jsonl`（全量；review_candidate 只进这里）
  - `review-queue/cninfo-rss-{batch_id}.json`（仅 hard_delta+high，待人工审）

归档只写 disclosures，**绝不**碰 `entities/` / `concepts/` / `relations/` / `evidence_index`。

## 定时（macOS LaunchAgent）

模板见 `templates/com.kb.cninfo-rss.plist`（每 30 分钟跑一次 --apply）。安装：

```bash
cp skills/cninfo-rss/templates/com.kb.cninfo-rss.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.kb.cninfo-rss.plist
```

## 接入 daily-ops 早间流程（建议）

1. 晨间跑一遍 `run.py --apply`（或 LaunchAgent 自动跑）。
2. 人工扫 `review-queue/cninfo-rss-*.json`（hard_delta+high 候选）。
3. 对确认的条目走 `disclosure-archive` 的 `apply_review_queue.py`（Stage 8）或
   `entity-delta-ingest` / `hard-fact-review` 入库。
4. review_candidate（low）仅留 manifest，供 theme-radar 排序与人工复核，不自动 apply。

## 非目标
- 不解析 PDF 全文（交给 disclosure-archive 人工/OCR）。
- 不做题材自动映射（`theme_term` 留空）。
- 不自动写 entity 正文，不接入 FinHot watchlist auto-import。
- 不依赖 akshare / requests（仅标准库 + PyYAML）。

## 经验与坑（按日期追加）
- **2026-06-30**：初版。巨潮 `column` 参数实测不按市场过滤，市场过滤改用 code 前缀；
  `category` 与 `searchkey` 服务端过滤有效；标题需去 `<em>` 高亮标签（已设 isHLtitle=false 兜底）。
  「股权激励计划」类标题因含「计划」会被降级为 review_candidate，属预期（保守）。
