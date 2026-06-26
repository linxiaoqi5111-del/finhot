# Grok X Runbook (native X → FinHot 中央缓存)

本文件给**内置 Grok agent**看:如何把抓到的 X/推特新数据喂进 FinHot 的中央缓存，
并出现在桌面 app 与公网站点（https://finhot.industry7view.com）。

调度器**不会自己联网抓 X**——它只会把已有的种子文件重新导入缓存。
所以「拉新 X 数据」这一步必须由 Grok 完成。

---

## 1. 数据流总览

```
Grok 用内置 X 工具拉新 post
        │  (x_keyword_search / x_semantic_search, mode=Latest)
        ▼
写入 apps/desktop/.finhot-cache/x_grok_entries.json   (GrokXPost[])
        │
        ▼
POST http://localhost:2233/api/public/refresh-x-grok   (导入中央缓存)
        │
        ▼
中央 .finhot-cache/ (manifest + entries + enrichment)  →  桌面 app & 公网
```

---

## 2. 种子文件格式

路径：`apps/desktop/.finhot-cache/x_grok_entries.json`
内容：一个 JSON 数组，每个元素是一个 `GrokXPost`：

```jsonc
[
  {
    "id": "x-cnfinancewatch-1932...", // 全局唯一，建议 "x-<screen>-<tweetId>"
    "source": "X@cnfinancewatch", // 显示用作者，格式 "X@<screen>"
    "title": null, // 可选，X 一般没标题，给 null 或省略
    "content": "正文全文（可含中文）",
    "url": "https://x.com/cnfinancewatch/status/1932...",
    "ts": 1750000000, // 发布时间，unix 秒（不是毫秒）
  },
]
```

字段说明（对应 `rss-proxy.ts` 的 `GrokXPost` 接口）：

| 字段      | 必填 | 说明                                                                                       |
| --------- | ---- | ------------------------------------------------------------------------------------------ |
| `id`      | ✅   | 全局唯一 id，去重用。**必须**用真实推文 id：`x-<screen>-<tweetId>`，**禁止** `demo*` 占位  |
| `source`  | ✅   | 作者展示名，**必须** `X@<screen>` 形式，screen 会被解析为 feed 与 `https://x.com/<screen>` |
| `content` | ✅   | 正文全文，**译成简体中文**（见下方翻译要求）                                               |
| `url`     | ✅   | 原推链接（真实 `https://x.com/<screen>/status/<tweetId>`，**禁止** demo 链接）             |
| `ts`      | ✅   | 发布时间，**unix 秒**（推文真实发布时间，不要用当前时间批量填同一值）                      |
| `title`   | ❌   | 可省略 / null；若填则同样用中文                                                            |

### 翻译要求（重要）

抓到的 X post 多为英文。**写入前请把 `content`（以及 `title` 若有）忠实翻译成简体中文**：

- 忠实、通顺、不增删信息，不做总结或评论。
- 保留专有名词、公司名、人名、股票代码/cashtag（如 `$NVDA`）、产品名；不确定时保留英文原文。
- 已是中文的内容原样保留，不要重复翻译。
- 译文直接写进 `content`（不要保留英文原文 + 译文两份）。

> 兜底：即便这里没翻，服务端富集流程也会用 LLM key 对非中文条目补译（写入 `en.translation`）。但首选由 Grok 在抓取时直接译好，质量与时效更优。

注意：

- 写入是**整体覆盖**这个文件（不是 append）。每次刷新时写入「当前要进缓存的全部 X 条目」。
- `loadGrokXEntries()` 会按 `source` 里的 screen 分组成每个用户一个 feed，分类标签 `推特 (native grok)`。
- `finhot/app/x_grok.py` 的 `save_for_proxy_cache(items)` 已经会把 finhot item 转成这个格式并写文件，可直接用。

---

## 3. 抓取名单与节奏（用户规则）

名单：`finhot/watchlist.json` 里的 `x` 列表（screen 名）。
节奏（北京时间 Asia/Shanghai，与雪球/微博一致）：

- 盘中 **09:30–15:00，每 30 分钟**一次
- 收盘后 **21:30** 一次
- 次日 **08:30** 一次

每次：

1. 对名单里每个 screen 用 `x_keyword_search(from:<screen>, mode=Latest, since=<上次时间>)`
   （必要时 `x_semantic_search` / thread 补全）拉最近的 post。
2. 把每条 post 的正文（及标题）**翻译成简体中文**（见第 2 节「翻译要求」）。
3. 规范化成 `GrokXPost`（用真实 tweetId / url / ts，禁止 demo 占位），合并/去重后**覆盖写** `x_grok_entries.json`。
4. `curl -X POST http://localhost:2233/api/public/refresh-x-grok`
   返回 `{"ok":true,"imported":N}`。

---

## 4. 让新内容上公网（finhot.industry7view.com）

公网是 **Cloudflare Pages**（项目 `finhot`）。刷新缓存后需要**重新部署**才会更新：

```bash
# 需要 Cloudflare 凭据
CF_API_TOKEN=xxx CF_ACCOUNT_ID=xxx \
  apps/desktop/scripts/deploy-pages.sh
# 或直接：
curl -X POST http://localhost:2233/api/public/deploy \
  -H 'Content-Type: application/json' \
  -d '{"cfApiToken":"xxx","cfAccountId":"xxx"}'
```

该端点会从 `.finhot-cache/` 生成自包含 HTML，用 `wrangler pages deploy` 推到
Cloudflare Pages `finhot` 项目，生产域名 https://finhot.industry7view.com。

> 部署目前是**手动**触发；如需「刷新后自动部署」，见 rss-proxy.ts 调度器，可在
> 每次定时刷新末尾加一次 `/api/public/deploy` 调用（需把 CF 凭据放进环境变量）。

---

## 5. 快速校验

```bash
# 看缓存里 X feed 是否进来
curl -s http://localhost:2233/api/public/manifest | python3 -m json.tool | grep -i grok

# 只刷 X
curl -X POST http://localhost:2233/api/public/refresh-x-grok

# 全量（微博+雪球+微信 + grokX）
curl -X POST http://localhost:2233/api/public/refresh
```
