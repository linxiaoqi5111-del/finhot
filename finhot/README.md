# 🔥 FinHot · 金融热词雷达

监控财经快讯中**突然爆发的热词**（如「钼代钨」「CCL」「τ定律」），量化其热度与热度变化，提供类 [AIHOT](https://aihot.virxact.com/) 风格的看板。

## 工作原理

```
采集器（每30分钟） → SQLite → 热词抽取 + 突发检测 → FastAPI → 网页看板
```

1. **采集**：抓取 6 个免登录财经快讯源——新浪财经7x24、东方财富快讯、华尔街见闻、同花顺快讯、格隆汇、财联社电报。单源失败不影响其余源。
2. **热词发现**：不依赖预设词表。候选词来自 jieba 分词 + 中文 2-4 字 n-gram（捕捉词典外新词如「钼代钨」）+ 英文/希腊字母 token（捕捉 CCL、τ 这类符号词），并做停用词与冗余子串过滤。
3. **事件聚类与信源分级**（借鉴 AIHOT，全部用代码实现，不引入模型）：
   - **事件聚类**：同一件事被多个源转发时（文本字符二元组 Jaccard 相似）聚成一个事件簇，热度按**事件数**而非条数计，避免转发刷屏放大「传播热」；详情页同一事件只展示信源最权威的主条，其余折叠
   - **信源分级**：T1 官方快讯线（财联社等 6 源，权重 1.0）> T1.5 媒体 RSS（0.7）> T2 博主（微博/雪球/公众号/X，0.4）；事件权重取簇内最高信源权重，同一题材官方提过比博主转发贡献的热度高（见 `app/events.py`，改权重/阈值后跑 `python recount.py` 重算历史）
4. **热度量化**：
   - **热度** = 当日提及该词的事件数；打分用**权重和**（各事件信源权重之和）
   - **突发倍数** = 当日权重和 ÷ 过去 N 天基线均值（N 可选 3/7/14）
   - **热度分** = `sqrt(今日权重和) × log2(突发倍数 + 1)`，兼顾规模和新颖度
   - **NEW 标记** = 基线窗口内从未出现过的全新词
5. **A股炒作闸口**（默认开启）：每条快讯按是否含炒作信号（涨停/概念/题材/产业链/订单/量产/国产替代/股票代码等，见 `terms.SPEC_SIGNALS`）打标；每个热词计算**炒作浓度** = 出现在炒作语境快讯中的占比。闸口开启时按浓度过滤（默认 ≥0.4）并对热度分加权，拦掉伊朗、加息这类对 A股炒作无直接意义的宏观政治词，只留产业题材词。
6. **词类型分类与三榜拆分**（`app/lexicon.py`，纯词表+代码）：每个热词分类为产业题材词 / 未知新词 / 公司实体 / 地缘词 / 事件催化词：
   - **产业题材榜**：白名单题材词（液冷/CPO/HBM/低空经济…）加权 ×1.5，未知新词（如「六氟化钨」）×1.0 保留新词发现能力，地缘词默认 ×0.3（同语境命中油气/军工/航运/黄金等关联词时恢复 ×1.0），实体词与事件词不进产业榜
   - **催化事件榜**：制裁/关税/轰炸/降息/扩产等事件词 + 地缘词，作为事件触发器单独展示
   - **实体异动榜**：公司/人物实体不直接当题材，通过映射表展示关联题材（如 SpaceX → 商业航天/卫星互联网）
7. **入库打分与准入**（Phase 1 内核，见 `app/scoring.py`）：过滤从查询期前移到入库期。每条快讯入库时即按 `0.30·影响力 + 0.35·相关性 + 0.20·新鲜度 − 0.15·重复度` 打分，≥0.45 才**准入**（admitted）计入热度统计，低分**存档**不丢；跨源近重复（72h 窗口字符二元组 Jaccard）合并到代表条（**去重**）。`score_parts` 存归一因子值，改权重/阈值后跑 `python recount.py --rescore` 可零丢失重算历史。
8. **看板**：三榜 tab 切换（产业题材 / 催化事件 / 实体异动），带迷你趋势线、炒作浓度、闸口开关；工具栏展示当日**准入漏斗**（准入 / 去重 / 存档）；点击热词查看历史趋势图、相关快讯原文及**每条入库打分与「存档」标记**。

## 快速开始

```bash
cd finhot
pip install -r requirements.txt

# 抓一次数据
python -m app.collector

# 启动看板（http://localhost:8000）
uvicorn app.server:app --host 0.0.0.0 --port 8000

# 后台持续采集（每30分钟一次），跑得越久基线越准、突发检测越灵
python -m app.collector --loop 30
```

## API

| 端点                                                                                  | 说明                                                                  |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `GET /api/hotwords?day=&baseline=7&limit=50&gate=1&min_spec_ratio=0.4&board=industry` | 热词榜（board=industry/event/entity 三榜；gate=0 关闭闸口看全部热词） |
| `GET /api/term/{term}?day=`                                                           | 单词详情：历史曲线 + 相关快讯（含每条入库分 `score`、`admitted`）     |
| `GET /api/stats`                                                                      | 各源条数、各日条数 + 准入漏斗（`admitted`/`archived`/`deduped`）      |
| `GET /feed/hot.json?day=&baseline=7&limit=30&gate=1&min_spec_ratio=0.4`               | 机器可读热榜：三榜合一 + 元信息，供下游聚合/播报                      |
| `GET /feed/brief.json` / `GET /feed/brief.md`                                         | 规则简报：导语 + 三段榜单（结构化 / Markdown 文本）                   |

### JSON Feed 与规则简报

`/feed/hot.json` 把三榜与元信息（生成时刻、当日条数、参数回显）打成一个 JSON，便于自动播报、二次聚合或外部消费——与看板 `/api/hotwords` 同源同算法（共用 `app/board.py`）。

规则简报**纯规则、无模型**（`app/brief.py`）：把「什么值得看」编码成显式阈值与标签——突发倍数 ≥3 标 `突发×N`、基线内新词标 `NEW`、产业词炒作浓度 ≥0.6 标 `高浓度`，并生成一句导语。Markdown 简报也可直接命令行产出（便于 cron/自动播报）：

```bash
python -m app.brief    # 打印当日 Markdown 简报到 stdout
```

### 导入 OPML / feeds.json

从任意 RSS 阅读器（Feedly/Inoreader/FreshRSS…）导出 OPML，一条命令把订阅迁进 `watchlist.json` 的 `rss` 列表（按 URL 去重，支持 `--dry-run` 预览、多文件、`--out` 指定目标）：

```bash
python -m app.feeds_import feeds.opml            # 合并进默认 watchlist.json
python -m app.feeds_import feeds.opml --dry-run  # 只预览不写盘
python -m app.feeds_import a.opml b.json --out wl.json
```

支持 OPML(.opml/.xml) 与多形态 feeds.json（原生 `[{name,url}]` / 整个 watchlist.json / OPML 转 JSON / 名称→URL 映射）。

## 扩展数据源

在 `app/sources.py` 中新增一个返回统一条目格式的函数并注册到 `SOURCES` 即可。雪球、公众号（搜狗微信）等有反爬或需登录态的源，可按同样接口接入。

## 博主监控（watchlist）

编辑 `finhot/watchlist.json`，填入要监控的博主，采集器会自动抓取他们的内容并进入同一套热词分析：

```json
{
  "weibo": ["1234567890"], // 微博博主 uid（数字），需游客 cookie（见下）
  "xueqiu": ["9876543210"], // 雪球用户 id（数字）
  "wechat": [], // 公众号（需配合 RSSHub 等代理渠道，见 app/watchlist.py）
  "x": ["elonmusk"] // X(Twitter) 用户名（不带@），经 Nitter/RSSHub 免费通路抓取
}
```

X 抓取走公共 Nitter 实例（xcancel.com 等）的 RSS，多实例自动切换；公共实例不稳定，全部失败时跳过该博主并记录错误，后续可升级为付费 API 或登录态抓取。

雪球匿名通路会先访问 /about 拿临时 token；机房/数据中心 IP 常被阿里云 WAF 滑块拦截（报错 `雪球 WAF 滑块拦截`），此时可在自己浏览器登录雪球后，把 cookie 填入环境变量 `XUEQIU_COOKIE` 或 `finhot/data/xueqiu_cookie.txt`（已 gitignore）；住宅/境内 IP 一般无需配置。

微博接口需游客 cookie，采集器会自动生成并在失效时自动续期（genvisitor2 接口，相当于自动新开一个无痕游客），保存在 `finhot/data/weibo_cookie.txt`；也可用环境变量 `WEIBO_COOKIE` 手动指定（如登录小号 cookie，额度更大）。

微博防频控：单号之间默认间隔 8 秒（环境变量 `WEIBO_SLEEP` 可调）；一旦碰到 IP 级频控（ok=-100）立即熔断，跳过本轮剩余微博博主（日志出现 `weibo:_rate_limited`），下一轮自动恢复，漏抓的内容下轮仍能补回。

列表为空时跳过；单个博主抓取失败不影响其余。

## 说明

- 数据存于 `finhot/data/finhot.db`（SQLite），首次运行自动创建。
- 冷启动当天没有历史基线，所有词都会标 NEW；持续运行几天后突发检测才真正生效。
