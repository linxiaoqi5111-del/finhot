# disclosure_lookup · 实时查新 API + 选择性 L3 沉淀系统

> 状态：**设计稿（Phase 0）**。本目录当前只有 `DESIGN.md` + 接口骨架（签名/契约，
> 未实现逻辑）。实现按下方「五期节奏」推进，每期单独评审。

## 1. 一句话定位

让 agent **在需要时**去官方源（巨潮 / 交易所 / 互动易 / 问询函…）**查、判断、筛选、
沉淀**——而不是把全市场公告无脑吞进知识库。核心是 **pull（按需拉取）**，不是
**push（定时全量扫）**。

## 2. 为什么不直接扩 `cninfo-rss`

仓库里已有 `skills/cninfo-rss/`，但它是另一种模型，二者**共生不替代**：

| 维度 | `skills/cninfo-rss`（已存在） | `disclosure_lookup`（本设计） |
| --- | --- | --- |
| 触发 | 定时 LaunchAgent，全市场扫 | agent/CLI 按需查一家公司或一个关键词 |
| 模型 | **push**：扫 → RSS → 自动归档 | **pull**：cache → source → triage → 选择性沉淀 |
| 范围 | 全市场分类码 + 关键词 | 指定公司 / 关键词 / 事件 |
| 源 | 仅巨潮 | 巨潮 + 互动易 + 问询函 + e互动 +（后置）港交所/IR |
| 产物 | RSS feed + L3 候选归档 | 统一记录 + TTL 缓存 + P0-P3 分级 + 证据卡 |

**复用而非重写**：巨潮抓取直接调 `skills/cninfo-rss/scripts/fetch_cninfo.py` 的
`CninfoClient` / `normalize_raw` / `classify`；triage 打分器吃 `cninfo-rss/config.yaml`
里那套 `fact_type` / `hard_delta_combo_rules` / `low_confidence_keywords` 税法，
两个系统共享同一套分级标准。

## 3. 仓库边界（硬规则）

```
finhot repo（本仓）         knowledge-base-private（同级 ../）
─────────────────          ──────────────────────────────
实时查 / 缓存 / 打分         L2/L3/反证 证据沉淀
问答调用                    产业链关系 / 实体页更新
                           （经验卡/学习层：判断对错的方法论修正）
```

- `disclosure_lookup` 只产出**证据卡候选**，写入 `../knowledge-base-private/`，且
  **必须人工/agent 确认后**才落库（沿用 cninfo-rss 的 review-queue 模式）。
- 绝不在本仓做长期知识沉淀；绝不直接改知识库的 `entities/` / `concepts/` /
  `relations/` 正文（那是知识库 repo 的 `disclosure-archive` 流程的职责）。

## 4. 架构与目录

```
查询请求（公司 / 关键词 / 事件）
   │
   ▼
lookup.py  ── cache-aside ──►  cache.py (SQLite, TTL)
   │  命中且未过期 → 直接返回
   │  未命中/过期 ↓
   ▼
sources/*  （统一 Source 协议）
   ├─ cninfo.py     复用 fetch_cninfo（零依赖直连）
   ├─ irm.py        互动易(深) + 上证 e 互动（akshare）
   ├─ inquiry.py    交易所监管问询函（akshare）
   └─ hkex.py / ir_site.py  （后置占位）
   │  归一化 → DisclosureRecord[]
   ▼
triage.py  6 维打分 → P0/P1/P2/P3
   │
   ├─ 写回 cache.py（含 triage 结果）
   └─ P0/P1 → evidence_card.py → 证据卡候选 → ../knowledge-base-private/（人工确认后落）
```

```
finhot/disclosure_lookup/
  DESIGN.md          # 本文件
  README.md          # 快速上手（指向 DESIGN.md）
  __init__.py
  schema.py          # DisclosureRecord 统一契约
  config.yaml        # 源开关 / TTL / triage 权重与阈值
  requirements.txt
  sources/
    __init__.py
    base.py          # Source 协议 + SourceResult
    cninfo.py        # 巨潮适配器（复用 fetch_cninfo）
    irm.py           # 互动易 + e互动
    inquiry.py       # 问询函
  cache.py           # SQLite cache-aside
  triage.py          # evidence_triage 打分器
  evidence_card.py   # 证据卡生成
  lookup.py          # 编排入口（service 函数）
  cli.py             # 命令行
  tests/             # 离线单测（后续期补）
```

## 5. 统一数据契约 `DisclosureRecord`

所有源归一化到同一结构（见 `schema.py`）。字段对应你列的「公司/日期/来源/标题/
链接/摘要/命中关键词/原文片段/来源可信度」：

| 字段 | 说明 |
| --- | --- |
| `company_name` / `company_code` | 公司名 / 6 位代码 |
| `source` | `cninfo` / `irm_szse` / `sse_einteract` / `inquiry_sse` / `inquiry_szse` … |
| `title` / `url` | 标题 / 原文链接（PDF 或问答页） |
| `published_at` | ISO8601 +08:00 |
| `summary` | **元数据级**摘要（标题 + 类型 + 问答片段），**不下 PDF 正文** |
| `matched_keywords` | 命中的关键词列表 |
| `raw_excerpt` | 原文片段（标题/互动问答原文） |
| `source_authority` | 来源可信度 0-3（交易所/巨潮=3，互动易/e互动=2，媒体=1） |
| `doc_hash` | 去重键（source + code + title + date 的 hash） |
| `fact_type` | 复用 cninfo 分类：`order_contract` / `mass_production` / … |
| `triage_level` / `triage_score` | triage 阶段补全：`P0`-`P3` / 0-100 |

口径承自 cninfo-rss：**只读标题 + 元数据 + 互动问答，不解析 PDF 正文**，所以最高
只能标 **L3 候选（`L1_L3_candidate`）**，升级为真 L3 需走知识库的 `disclosure-archive`
（下 PDF → 解析 → 抽事实 → 概念映射 → review）。

## 6. 源适配器层

统一协议（见 `sources/base.py`）：

```python
class Source(Protocol):
    name: str
    authority: int
    def search_company(self, code, name, *, days) -> list[DisclosureRecord]: ...
    def search_keyword(self, keyword, *, days, codes=None) -> list[DisclosureRecord]: ...
```

| 源 | 实现路径 | 数据来源 | 期次 |
| --- | --- | --- | --- |
| 巨潮公告 | `sources/cninfo.py` | 复用 `fetch_cninfo`（直连 hisAnnouncement，零依赖） | P1 |
| 互动易(深) | `sources/irm.py` | akshare `stock_irm_cninfo` / `stock_irm_ans_cninfo` | P1 |
| 上证 e 互动 | `sources/irm.py` | akshare `stock_sns_sseinfo` | P1 |
| 交易所问询函 | `sources/inquiry.py` | akshare 监管问询接口 | P1 |
| 港交所披露易 | `sources/hkex.py` | 后置 | P5+ |
| 公司官网 IR | `sources/ir_site.py` | 后置（需逐站适配/抓取） | P5+ |

**依赖隔离（关键设计）**：`akshare` 只在 `irm.py`/`inquiry.py` 的**方法内部延迟
import**，巨潮路径保持零依赖。这样 akshare 抽风时不影响巨潮，且随时可换成手写直连。

## 7. 缓存层（cache-aside + TTL）

**原理**：cache-aside（旁路缓存）——先查缓存，命中且未过期直接返回；未命中才打外部
源，拿到结果**写回缓存**。降低对官方接口的压力、避免触发限频。（面试常考：cache-aside
vs read/write-through 的区别——前者由应用控制读写、缓存与源解耦，最常用。）

**存储选型：SQLite**（标准库，零依赖，文件型 OLTP，按公司/关键词点查天然合适）。
替代方案：DuckDB（盘面分析在用，但强在列式扫描，做 KV 缓存杀鸡用牛刀）、JSONL（最糙、
无索引）。缓存只存**元数据 + 摘要 + 关键片段**，**不全文向量化**。

表结构（你给的 schema → SQLite DDL，见 `cache.py`）：

```sql
CREATE TABLE disclosure_cache (
  doc_hash        TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  company_code    TEXT,
  company_name    TEXT,
  title           TEXT,
  url             TEXT,
  published_at    TEXT,
  summary         TEXT,
  raw_excerpt     TEXT,
  matched_keywords TEXT,         -- JSON array
  source_authority INTEGER,
  fetched_at      TEXT NOT NULL,
  ttl_expires_at  TEXT NOT NULL,
  review_status   TEXT DEFAULT 'pending',  -- pending/kept/discarded/sunk
  triage_level    TEXT,
  triage_score    REAL
);
CREATE INDEX idx_company ON disclosure_cache(company_code, published_at);
CREATE INDEX idx_ttl ON disclosure_cache(ttl_expires_at);
```

- **TTL**：默认 7 天（可在 `config.yaml` 调到 30 天）；过期记录视为 miss，重查刷新。
- **查询缓存命中判定**：用 `(source, company_code, days 窗口)` 维度的「查询水位」记录
  最近一次成功拉取时间；窗口内已拉过且未过期 → 直接读缓存，不打源。

## 8. triage 打分器（P0-P3）

**模型：规则定级 + 分数排序**（不是纯阈值）。规则给硬保证（边界稳定），分数只管同级内
排序。这套在风控/告警分级里通用。

6 维各 0-3 分（见 `triage.py`）：

| 维度 | 取分依据 |
| --- | --- |
| `source_authority` | 交易所/巨潮=3，互动易/e互动=2，媒体=1 |
| `fact_hardness` | cninfo `hard_delta`=3，`review_candidate`=1，「拟/计划/框架」降级 |
| `company_relevance` | 主营直接命中=3，边缘=1 |
| `novelty` | 知识库未见=3，重复=0（后期用 :8077 embedding 语义去重） |
| `lifecycle_impact` | 改变逻辑生命周期（升级/降级/**反证**）=3 |
| `market_relevance` | watchlist/题材核心股=3 |

分桶（**硬门槛优先**，分数辅助排序）：

| 级 | 触发条件 | 处理 | 例子 |
| --- | --- | --- | --- |
| **P0** | `fact_hardness=3` 且 `lifecycle_impact≥2` | 建议沉淀 L3/反证 | 订单、客户验证、量产、投产、扩产、涨价、明确否认 |
| **P1** | `fact_hardness≥2`，但需复核 | 进人工/agent 复核 | 互动易产品进展、送样、收入占比 |
| **P2** | 官方源但 `fact_hardness≤1` | 仅缓存 | 股东大会、董监高变动、普通风险提示 |
| **P3** | 命中 `exclude_any` 噪音 | 忽略 | 无关公告、模板化、重复材料 |

> **反证很关键**：如「公司否认产品用于 CoWoS/TGV」——负面，但对逻辑生命周期影响大，
> 应判 P0、沉淀成**反证资产**（`evidence_layer=L3_negative`）。

## 9. 证据卡（evidence card）

只有 P0/P1 才生成结构化证据卡（YAML，见 `evidence_card.py`），**不是全文入库**：

```yaml
company: 瑞华泰
code: 688323
date: 2026-XX-XX
source_type: 互动易
source_url: https://...
evidence_layer: L3_negative        # L3 / L3_negative / L1_L3_candidate
fact: 公司称 PSPI 仍处早期研发，产品未用于 CoWoS/TGV
fact_type: customer_validation
theme_links: [先进封装, PI膜, AI硬件]
lifecycle_impact: 先进封装逻辑降级
confidence: high
triage_level: P0
raw_excerpt: "..."
review_status: pending             # 人工确认后才落知识库
```

落点：`../knowledge-base-private/wiki/raw/disclosures/` + review-queue；**人工确认前
不进知识库正文**。

## 10. 问答接入流程（Phase 4）

```
本地 wiki/年报/实体页
  → DuckDB 盘面/题材/强度
  → 发现缺口（缺最新客户验证/产品结构/反证？）
  → 调 disclosure_lookup 实时查
  → 结果进 triage
  → 高价值事实用于回答
  → 若影响生命周期，写入 L3 证据候选
```

回答里**明确标注**来源与层级，例如：

> 「本地知识库未见最新客户验证，本轮调用公告/互动易查询补盲；查到的信息属于
> **L3 候选/反证**，已建议沉淀。」

## 11. 五期节奏

| 期 | 范围 | 复用 / 新建 | 验收 |
| --- | --- | --- | --- |
| **P1 MVP** | 按公司查近 30 天公告/互动易/问询函 + 缓存 + 返回摘要 | 巨潮复用 `fetch_cninfo`；互动易/问询函各接 1 源 | CLI 查一家公司出统一结果；二次查命中缓存 |
| **P2** | triage 打分器 → P0-P3 | 复用 cninfo 税法 | 同一批结果稳定分级 |
| **P3** | 证据卡生成（人工确认后写库） | review-queue 模式 | P0/P1 产出 YAML 候选 |
| **P4** | 普通问答触发实时查补盲 | 接 DuckDB/wiki 缺口检测 | 问答自动补盲 + 标注层级 |
| **P5** | 盘后轻量监控（只 watchlist/持仓/强题材核心） | 复用 P1-P3 | 不全市场扫 |

P1 **不向量化、不自动写库**。

## 12. 接口形态：先 service+CLI，后 API

Phase 1 只做 **service 函数 + CLI**（命令行验证逻辑最快）。稳定后再包 **FastAPI/MCP
工具**（与 `finhot/embed/server.py` 同形态，给 finhot/网页端/其他 agent 调用）。
替代方案是一上来就 FastAPI，但早期多一层部署/接口维护成本，不划算。

## 13. 运行方式（规划）

```bash
# 按公司查（cache-aside）
python3 -m disclosure_lookup.cli company 瑞华泰 --days 30
python3 -m disclosure_lookup.cli company 688323 --source cninfo,irm

# 按关键词查
python3 -m disclosure_lookup.cli keyword "CoWoS 否认" --days 30

# 缓存维护
python3 -m disclosure_lookup.cli cache --stats
python3 -m disclosure_lookup.cli cache --purge-expired
```

## 14. 环境依赖

- Python ≥ 3.9（与 cninfo-rss 一致）。
- `PyYAML`：读 `config.yaml`（注意：本机系统 `python3` 未装 PyYAML，需 venv 或
  `pip install -r requirements.txt`；或改用 JSON 配置规避）。
- `akshare`：仅互动易/问询函用，方法内延迟 import。
- 复用 `skills/cninfo-rss/scripts/fetch_cninfo.py`：通过 sys.path 注入其目录后 import。

## 15. 非目标

- 不解析 PDF 正文（交知识库 `disclosure-archive`）。
- 不全市场扫（那是 cninfo-rss 的活）。
- 不自动写知识库正文（必须人工/agent 确认）。
- P1 不做向量化、不做 rerank（后续期再上 Hybrid 检索）。
