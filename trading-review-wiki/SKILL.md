---
name: trading-review-wiki
description: >
  Operate a personal trading-review knowledge base through the Trading Review Wiki
  Codex CLI — multi-source RAG question answering (wiki / raw / graph / facts /
  brain / stock_daily_sql), app-grade source ingestion (prepare → api-run →
  finalize → apply --write), premarket prediction & postclose validation
  (daily-loop), company deep research, long-term brain memory, and temporal-facts
  auditing. 用 Trading Review Wiki CLI 维护和检索一个交易复盘知识库。
  MUST trigger when the user wants to: 摄入/录入复盘资料、问知识库("我的知识库里…"、
  "复盘一下"、"最近主线/产业链有什么变化")、盘前预测、盘后验证、daily-loop、
  公司深度研究、记一条纠错/经验(brain)、行情验证一个判断、检查 wiki 质量(hygiene)、
  审计时序事实(temporal-facts)。Also trigger on English equivalents: "ask my trading
  wiki", "ingest this into my wiki", "run the daily loop", "deep research this stock",
  "remember this correction". Do NOT use for generic web research (use hv-analysis)
  or article writing (use khazix-writer). Cross-platform: Claude Code · OpenAI Codex ·
  OpenCode · OpenClaw.
---

# Trading Review Wiki — CLI 操作手册

> **Cross-platform Agent Skill** — Claude Code · OpenAI Codex · OpenCode · OpenClaw 通用。
> 遵循开放 [Agent Skills](https://agentskills.io) 规范。

你正在操作 **Trading Review Wiki**：一套围绕「活的交易复盘知识库」运行的 Codex CLI 工具集。
你的职责不是写流水账，而是把原始资料、正式 wiki、知识图谱、长期记忆和结构化时序事实组织成
一个**可检索、可验证、可纠错、可迭代**的研究系统。

这个目录同时就是工具的源码仓库。完整说明见同目录下：
- [`README.md`](./README.md) — 命令总览与快速开始
- [`docs/多源检索RAG完整流程.md`](./docs/多源检索RAG完整流程.md) — `ask` 如何融合六路证据
- [`docs/temporal-facts-v1.md`](./docs/temporal-facts-v1.md) — 时序事实账本设计
- [`docs/交易复盘Schema参考模板.md`](./docs/交易复盘Schema参考模板.md) — 从 0 建库的 schema
- [`docs/CLI外部接入与使用指南.md`](./docs/CLI外部接入与使用指南.md) — 非 Codex 软件如何接入

## 0. 三个角色与三层数据（先理解，否则会越界写入）

| 角色 | 负责 |
|---|---|
| 人类 | 提供原始资料、提出关键问题、裁决高风险判断 |
| LLM/Agent（你） | 归纳资料、维护 wiki、发现矛盾、补双链和来源 |
| 程序化层（本 CLI） | 维护索引、日志、事实账本、审计报告、批量写入边界 |

| 路径 | 角色 | 写入纪律 |
|---|---|---|
| `raw/**` | 原始资料层 | **只追加，永不改写/删除**；CLI 永不写 raw |
| `wiki/**` | 正式知识层 | 由 LLM 维护，可审阅可回滚 |
| `data/facts/**` | 时序事实层 | 会变化/可证伪的事实（订单、验证、涨价、政策…） |
| `data/brain/**` | 长期记忆层 | 纠错、偏好、预测、guardrail |
| `.llm-wiki/**` | 运行产物层 | dry-run、审计、eval、staging 报告 |

**铁律**：`ask` 永远只读；`apply` 没有 `--write` 一律 dry-run；`raw/` 永不被任何命令写入。

## 1. 环境准备（一次性）

```sh
cd <这个 trading-review-wiki 目录>
npm install
npm test -- --run          # 确认本机能跑通核心逻辑
```

两个必须确认的参数：
- `--project <wiki-root>`：指向用户**本地的知识库工作区**（不是这个源码仓库）。
  源码里的 `DEFAULT_PROJECT_PATH` 只是作者本机路径，几乎总是需要显式传 `--project`。
- `--provider codex`：默认用本地 Codex CLI 登录态；没有 Codex 时用 `--provider openai` +
  `OPENAI_API_KEY`（或 `--api-key`）。**没有任一 provider 时，`ask`/`api-run`/`daily-loop`/
  `company-research` 这些需要 LLM 的命令无法运行**——先向用户确认凭据。

不需要 LLM 即可跑的命令：`prepare`、`hygiene audit|plan`、`temporal-facts audit`、
`apply`（dry-run）、`brain status`、以及 `npm test`。可用它们先验证环境再上 LLM 命令。

## 2. 选对命令（决策表）

| 用户想做的事 | 用哪个命令 |
|---|---|
| 问知识库一个问题 | `ask`（只读，多源 RAG） |
| 评估检索质量 | `ask eval --expect-paths ...` |
| 把一篇资料正式摄入 wiki | `prepare → api-run → finalize → apply --write` |
| 盘前预测 / 盘后验证 | `daily-loop --mode premarket|postclose` |
| 公司深度研究底稿 | `company-research --stock <名/代码> --deep` |
| 记一条纠错/经验/偏好 | `brain remember --type correction|thread|preference|guardrail` |
| 用行情验证一个判断 | `market-validate --prediction ... --stock ...` |
| 体检 wiki（孤页/矛盾/陈旧） | `hygiene audit|plan|apply` |
| 审计可建的时序事实候选 | `temporal-facts audit` |

所有命令统一前缀 `npm run codex:ingest -- <command> ...`。先 `npm run codex:ingest -- help` 看全量参数。

## 3. 多源问答 `ask`（最常用，只读）

```sh
npm run codex:ingest -- ask \
  --query "最近一周机器人产业链有哪些变化？区分订单兑现和情绪催化" \
  --project <wiki-root> --provider codex --show-context --show-sources
```

- `--sources auto|wiki,raw,graph,facts,brain,stock-price`：控制证据源；`auto` 让规则+LLM 路由。
- `--graph-depth auto|1|2`：图谱扩展深度；产业链/受益方向类问题会自动二跳。
- `--include-invalidated`：把 `superseded/invalidated/expired` 历史和反证事实也纳入，用于追查矛盾。
- 证据统一编号 `W/R/G/F/M/S`，答案固定六段：结论 / 证据链 / 分歧反证 / 后续验证 / 交易含义 / 引用来源。
- **默认只用 active/current 事实**作为 `[F]` 证据，避免旧事实污染答案。

`--show-context` 打印命中的检索片段，`--show-sources` 打印 source routing 与各 native 源查询摘要——
排查"为什么这条没被检索到"时务必带上。

## 4. App-grade 摄入（写 wiki 的唯一正路）

```sh
npm run codex:ingest -- prepare  --source <raw.md> --project <wiki-root>
npm run codex:ingest -- api-run  --source <raw.md> --project <wiki-root> --provider codex --model gpt-5.5
npm run codex:ingest -- finalize --report <.llm-wiki/codex-ingest/<id>> --provider codex
npm run codex:ingest -- apply    --manifest <changes.json> --project <wiki-root> --write
```

摄入后、`apply --write` 前必须逐项确认：
- `fatal == 0`、`wroteRaw == false`、`wroteRootLog == false`
- source hash 稳定、`wiki-change-review.md` 已人工审阅
- **写入范围明确**（先看 dry-run 的 plan，再决定是否 `--write`）

`factWrites` 只能写 `data/facts/temporal_edges.jsonl`；`writes` 只能写 `wiki/**/*.md`、
`wiki/index.md`、`wiki/overview.md`、`wiki/logs/log-YYYY-MM-DD.md`。

## 5. 盘前/盘后 daily-loop

```sh
# 盘前预测
npm run codex:ingest -- daily-loop --mode premarket --project <wiki-root> --provider codex \
  --model gpt-5.5 --reasoning-effort xhigh --lookback-days 30 \
  --validation-windows 1,3,5,10,20 --write
# 盘后只验证待验证项
npm run codex:ingest -- daily-loop --mode postclose --validate-pending-only --project <wiki-root> --write
```

语义要点：预测从 `createdAt/answeredAt/date` 后的**第一个交易日**开始验证；1/3/5/10/20 日是
独立 horizon，不互相覆盖；周末/非交易日默认 skip（除非 `--force`）。`daily-loop` 只在带 `--write`
时写 `data/brain` 和 `.llm-wiki/daily-research` 或 `.llm-wiki/wiki-feedback`。

## 6. 其它

- **公司研究**：`company-research --stock <名/代码> --deep`，产物在 `.llm-wiki/company-research/<id>/`
  （深度报告、财务模型 xlsx、证据账本、质量审计、wiki 写入候选）。**不直接写正式 wiki**。
- **长期记忆**：`brain remember/status/resolve`。Brain 只作为验证约束，不能单独当作市场事实。
- **行情验证**：`market-validate --prediction ... --stock <代码> --window 20d`，走只读 PostgreSQL 日线。
- **质量治理**：`hygiene audit|plan` 只读；`hygiene apply --write` 只清理旧的成功 ingest 报告目录。
- **时序事实审计**：`temporal-facts audit` 从 `wiki/**/*.md` 提取 predicate/alias/tag/缩写候选给人工复核，
  输出到 `.llm-wiki/temporal-facts/`，**不自动改写 wiki**。

## 7. 股票 SQL 安全规则（重要）

行情 SQL 是**可选只读源**，连接信息只从本机环境变量 / 私有配置 / 系统钥匙串读取。
- 不打印密码、不把密码写入文件、不提交到 git。
- 配置缺失时返回 "evidence insufficiency"，**绝不编造行情**。
- 共享时只提交变量名和安全规则，不提交个人连接细节。

## 8. 自检清单（动手写入前过一遍）

- [ ] `--project` 指向的是用户的知识库工作区，不是源码仓库
- [ ] 需要 LLM 的命令已确认 provider（codex 登录或 OPENAI_API_KEY）
- [ ] 任何 `apply` 先看过 dry-run plan，再决定 `--write`
- [ ] 没有任何命令试图写 `raw/**`
- [ ] `ask` 的回答逐条引用了 `W/R/G/F/M/S` 证据编号
- [ ] 涉及行情时，没有在缺配置的情况下编造量价
