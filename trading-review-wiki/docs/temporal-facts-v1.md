# Temporal Facts v1

Temporal Facts 是 Trading Review Wiki 的时间事实账本。它不替代 `wiki/**/*.md`，只把会随时间变化、需要验证或可能被证伪的交易事实写入 `data/facts/temporal_edges.jsonl`。

## 已确认口径

| 事项 | 口径 |
|---|---|
| `active` | 允许承载待验证事实；但 C/D 证据必须在 `claim` 中写清“传闻、待验证、观察项、尚未确认”等限定 |
| Predicate 词表 | 先用 v1 默认词表；后续从现有 wiki 库中提取高频事实关系，再由人确认是否新增 |
| C/D 证据 | 继续作为 warning 处理，不做 fatal；允许进入账本，但不能被回答当成确认事实 |
| 回填范围 | 优先回填订单、客户、涨价、政策、产能、反证/证伪、关键主线股票，不做全库无差别回填 |
| 概念别名 | 需要人和系统共同维护，先从 wiki/概念、wiki/股票、tags、aliases、常见同义词中提取候选，再人工归类 |

## 写入边界

| 字段 | 规则 |
|---|---|
| `writes` | 只写 `wiki/**/*.md`、`wiki/index.md`、`wiki/overview.md`、`wiki/logs/log-YYYY-MM-DD.md` |
| `factWrites` | 只写 `data/facts/temporal_edges.jsonl` |
| `raw/**` | 永远不写 |
| 索引 | 写入新 fact 后自动重建 `data/facts/temporal_edges.index.json` |

## 最小字段

每条 temporal fact 至少应该包含：

```json
{
  "path": "data/facts/temporal_edges.jsonl",
  "subject": "三孚新科",
  "predicate": "HAS_ORDER",
  "object": "mSAP电镀设备订单",
  "claim": "三孚新科 mSAP 电镀设备订单尚未确认，需要继续跟踪公告或互动平台。",
  "status": "active",
  "evidenceLevel": "C",
  "sourceKind": "expert_meeting",
  "validAt": "2026-05-29",
  "sourceDate": "2026-05-29",
  "sourcePath": "raw/研报新闻/2026-05-29-三孚新科澄清.md",
  "sourceHash": "source hash",
  "wikiPath": "wiki/股票/三孚新科.md",
  "supersedes": []
}
```

CLI 会自动补充：

| 字段 | 含义 |
|---|---|
| `id` | 基于事实身份生成的稳定 ID |
| `entityKey` | 归一实体，例如 `stock:SH688359` 或 `entity:ai服务器电源` |
| `canonicalSubject` | 规范实体名 |
| `stockCode` | 股票代码，能识别时自动补齐 |
| `aliases` | 实体别名 |

## Predicate 词表

| predicate | 用途 | 常见对象 |
|---|---|---|
| `HAS_CATALYST` | 催化剂事实 | 政策、订单、会议、涨价、产品发布 |
| `HAS_ORDER` | 订单大类兼容项；优先细分 | 订单 |
| `HAS_ORDER_RUMOR` | 订单传闻或小作文 | 加单传闻、群聊截图、未确认订单 |
| `HAS_ORDER_INTENT` | 客户意向、定点、预计导入 | 定点、客户意向、送样后预计导入 |
| `HAS_CONFIRMED_ORDER` | 强信源确认的订单 | 合同、中标、正式订单、公告订单 |
| `HAS_DELIVERY_VALIDATION` | 交付兑现 | 批量供货、持续交付、放量出货 |
| `HAS_CUSTOMER` | 客户关系 | 客户名称、下游厂商 |
| `HAS_CAPACITY` | 产能、扩产、投产 | 产线、产能规模、投产时间 |
| `HAS_PRICE_SIGNAL` | 涨价、降价、价格弹性 | 产品价格、报价变化 |
| `HAS_POLICY_SUPPORT` | 政策支持 | 政策文件、补贴、产业规划 |
| `HAS_PRODUCT` | 产品或业务线事实 | 产品、材料、设备、服务 |
| `HAS_TECH_PROGRESS` | 技术进展 | 认证、样品、量产、良率 |
| `HAS_SUPPLY_CONSTRAINT` | 供给约束 | 缺货、扩产瓶颈、原料瓶颈 |
| `HAS_VALIDATION_SIGNAL` | 市场或基本面验证信号 | 股价、成交、公告后反馈、产业验证 |
| `PRICE_VALIDATED` | 价格验证 | ASP、报价、提价、涨价落地 |
| `VOLUME_VALIDATED` | 量的验证 | 放量、批量供货、产量、稼动率 |
| `CUSTOMER_VALIDATED` | 客户验证 | 客户、进入供应链、绑定客户 |
| `TECH_VALIDATED` | 技术验证 | 认证、良率、样品、验证通过、量产 |
| `FUNDAMENTAL_VALIDATED` | 基本面兑现 | 财报兑现、业绩兑现、订单转收入 |
| `HAS_RISK` | 风险或反证线索 | 业绩风险、澄清、竞争、政策变化 |
| `HAS_CLARIFICATION_RISK` | 口径或澄清风险 | 澄清、否认、未确认、撤回、口径冲突 |
| `HAS_COMPETITION_RISK` | 竞争风险 | 竞争、替代风险、同业扩产 |
| `HAS_DEMAND_RISK` | 需求风险 | 需求不及预期、价格下修、订单下修 |
| `HAS_SUPPLY_CHAIN_RISK` | 供应链兑现风险 | 供应链卡点、良率不达标、扩产不及预期 |
| `HAS_VALUATION_RISK` | 交易透支风险 | 预期兑现、高开低走、追高 |
| `VALIDATES` | 后续来源验证旧事实 | 被验证的旧 fact 或命题 |
| `CONTRADICTS` | 后续来源反驳旧事实 | 被反驳的旧 fact 或命题 |

新增 predicate 前先问三个问题：

- 它是不是和现有 predicate 语义不同？
- 它能否被稳定检索和复盘使用？
- 它是否有明确的必填对象和证据来源？

Predicate 扩展优先参考现有 wiki 库，不直接凭空添加。推荐流程：

1. 扫描 `wiki/股票/**`、`wiki/概念/**`、`wiki/模式/**` 中的标题、二级标题、tags、aliases 和正文高频关系词。
2. 把候选关系映射到现有 predicate；能映射的先不新增。
3. 对无法映射但高频、交易上有复用价值的关系，整理成候选 predicate。
4. 人工确认后再进入词表和 CLI 校验。

Predicate 扩展原则：不要只按词扩，要按“事实强度”扩。`订单` 这种词本身是歧义入口，必须按信源和上下文拆成传闻、意向、确认订单或交付兑现。`验证` 也必须尽量拆成价格、量、客户、技术或基本面兑现。

## Status 生命周期

| status | 含义 | 默认问答行为 |
|---|---|---|
| `active` | 当前仍可作为观察事实或待验证事实使用 | 默认进入 `[F]` 主证据 |
| `superseded` | 已被后续事实替代 | 默认不进主证据，`--include-invalidated` 时进入历史/反证 |
| `invalidated` | 已被证伪、撤回或明确反驳 | 默认不进主证据，`--include-invalidated` 时进入历史/反证 |
| `expired` | 时间窗口已过，仍可作历史参考 | 默认不进主证据，`--include-invalidated` 时进入历史/反证 |

注意：`active` 不等于“已经确认”。确认强度由 `evidenceLevel` 和 `sourceKind` 决定。C/D 证据写入 active 时，`claim` 必须明确写“传闻、待验证、观察项、尚未确认”等限定。

## Evidence Level

| 等级 | 定义 | 可否写 active |
|---|---|---|
| `A` | 公告、财报、交易所互动、政府文件、可复现市场数据 | 可以 |
| `B` | 券商研报、产业数据库、公司 IR、可靠行业调研 | 可以，但要保留来源口径 |
| `C` | 专家会议、媒体报道、会议纪要、非官方产业口径 | 可以作为待验证 active，不可写成确认事实 |
| `D` | 群聊、小作文、无法确认的传闻 | 原则上只作为观察项；claim 必须弱化 |

## Source Kind

| sourceKind | 说明 |
|---|---|
| `official_announcement` | 公司公告 |
| `financial_report` | 定期报告、财报 |
| `exchange_interaction` | 互动易、上证 e 互动、交易所问答 |
| `government_policy` | 政策文件、政府公告 |
| `company_ir` | 公司调研、IR、官网 |
| `broker_research` | 券商研报 |
| `industry_database` | 产业数据库、第三方结构化数据 |
| `expert_meeting` | 专家会议、电话会、纪要 |
| `media_report` | 媒体报道 |
| `social_chat` | 微信群、聊天记录、小作文 |
| `market_price` | 股价、成交量、成交额、盘口市场数据 |
| `manual_review` | 人工复核或手工标注 |

## 时间字段

| 字段 | 含义 | 例子 |
|---|---|---|
| `sourceDate` | 来源发布日期或资料日期 | `2026-05-29` |
| `eventDate` | 事件发生日期 | `2026-05-28` |
| `validAt` | 该事实在知识库中被认为有效的时间点 | `2026-05-29` |
| `validUntil` | 明确失效或窗口结束日期 | `2026-06-15` |
| `observedAt` | 系统摄入或观察到该事实的时间 | `2026-05-29 21:30:00` |

至少应提供 `validAt`、`eventDate`、`sourceDate`、`observedAt` 之一。交易上优先写 `validAt`。

## 原子事实粒度

一条 fact 只表达一个事实。

不推荐：

```json
{
  "subject": "某公司",
  "predicate": "HAS_ORDER",
  "claim": "某公司拿到苹果订单、金额 2 亿、下半年放量、股价有望重估。"
}
```

推荐拆成：

```json
[
  { "predicate": "HAS_CUSTOMER", "object": "苹果", "claim": "某公司被来源称进入苹果供应链，仍待官方验证。" },
  { "predicate": "HAS_ORDER", "object": "苹果订单", "claim": "某公司被来源称获得苹果订单，金额口径待验证。" },
  { "predicate": "HAS_VALIDATION_SIGNAL", "object": "下半年放量窗口", "claim": "来源给出的验证窗口是 2026 年下半年。" }
]
```

## 反证和替代

新来源推翻旧事实时，不直接改旧 JSONL 行，而是在新 fact 中引用旧 fact id：

```json
{
  "predicate": "CONTRADICTS",
  "status": "active",
  "claim": "后续来源显示旧订单说法尚未确认，不能作为确认订单事实使用。",
  "supersedes": ["tf_old_order_id"]
}
```

CLI 会根据 `supersedes`、`invalidates`、`contradicts` 动态把旧 fact 视为 `superseded` 或 `invalidated`。

## 人工复核清单

需要人类优先补标的情况：

- C/D 证据被写成 active。
- 新来源明显反驳旧事实，但 `supersedes` 为空。
- 同一实体出现多个 `entityKey`。
- claim 里同时包含订单、客户、金额、时间窗口、投资结论。
- 只有群聊热度，没有事实锚点。
- 关键主线或重仓股票相关事实。

## 回填优先级

v1 不追求全库回填，先做交易判断中最容易造成误判的事实类型。

| 优先级 | 范围 | 说明 |
|---|---|---|
| P0 | 反证/证伪/澄清 | 先把旧错误结论移出默认 active view |
| P0 | 订单、客户、涨价、政策 | 最容易影响交易预期和催化判断 |
| P1 | 产能、技术进展、供给约束 | 用于产业链强弱和验证窗口 |
| P1 | 关键主线股票 | 主线、重仓、反复出现的股票优先 |
| P2 | 普通概念背景 | 可后置，不影响短期交易判断时不急 |

## 概念别名共同维护

股票实体可以主要依赖代码归一，但概念、材料、设备、产业链环节需要逐步维护别名。

候选来源：

- `wiki/概念/**` 的标题、aliases、tags、related。
- `wiki/股票/**` 中高频出现的产品、材料、客户、工艺。
- raw source 中反复出现的英文缩写、中文简称、行业俗称。
- 已有 fact 的 `subject/object/claim` 高频词。

维护原则：

- 一个概念只保留一个 `canonicalSubject`。
- 英文缩写和中文名保留在 aliases，例如 `mSAP`、`类载板`。
- 材料、设备、工艺、客户、政策不要混成一个概念。
- 不确定的候选先进入人工复核，不自动合并。

## 审计候选固化规则

`temporal-facts audit` 的 Predicate / Alias / Tag / Abbreviation 都只是候选。机器可以标注分类，但不能自动把候选写回 wiki。

最关键的固化规则：

- 凡是行业、赛道、技术范式、交易链，不当普通 alias，优先晋升或维护为概念页。
- 凡是价格、供给、客户、良率、订单、批量供货，优先进入 Predicate，不只当 tag。
- 凡是公司名、药物代码、产品代码，不互相当 alias；公司与产品用 related 或 temporal fact 连接。
- 凡是传闻、未确认、小作文、群聊截图，不能进入 `HAS_CONFIRMED_ORDER`，只能进入 `HAS_ORDER_RUMOR` 或待验证 active。
- 凡是涨价链、短缺体系、价值量提升，多数不是同义词，而是同一条交易链的不同切片。

Tag 分类：

- `promote_concept`：可承载独立产业链、时间线、上下游、公司映射或交易框架，优先维护为正式概念页。
- `metadata_only`：只做来源、场景或粗标签，不晋升为概念页。
- `method_or_error_page`：进入方法论、模式或错误页体系。
- `review`：需要人工判断。

缩写分类：

- `alias_whitelist`：可以作为 alias 候选，但仍要绑定到正确概念或实体，例如 `CPO`、`NPO`、`MLCC`、`AIDC`、`CoPoS`、`TGV`、`DrMOS`、`SST`、`mSAP`、`ABF`。
- `blocked_alias`：不要自动挂靠为 alias；如果有价值，应作为实体或主题词单独处理，例如 `AI`、`Call`、`L4`、`IPO`、`Token`、`Google`、`NVIDIA`、`SpaceX`、`Rubin`、`DeepSeek`。
- `review`：人工判断是有效简称、产品代码、公司代码还是噪声。

概念层级原则：

- AI 服务器 PCB 体系中，`AI服务器PCB价值量提升` 是主概念；短缺、涨价、价值量提升是不同交易切片。
- 先进封装体系中，`3D堆叠` 是技术总称，不直接等于 `LogicFolding`。
- 光通信体系中，`光互联Scale-Up` 是上位大周期，不吞并具体器件页。
- AIDC 电力体系中，`AIDC电力` 是上位主题，`SST` 是技术实体，`AI服务器电源价值量提升` 是投资切片。
- 国产算力体系中，`国产算力链` 是上位主题，不直接并入 `国产算力替代加速`。
- 商业航天体系中，`千帆星座` 是上位主题，`太空数据中心 / 在轨数据中心 / 轨道数据中心` 先统一方向，再决定是否建子页。

总体裁决：不要过度合并。这个 wiki 是交易用知识库，不是百科全书；很多冲突不是重复，而是上位主题、事件催化、供需切片、价格切片、价值量切片混在一起。规则要让机器学会分层，而不是把所有相似词都并成一个大页。

## v1 暂不做

- 不全库自动回填。
- 不把 fact id 写入 wiki frontmatter。
- 不引入 Neo4j 或外部图数据库。
- 不把 C/D 证据自动升级为确认事实。
