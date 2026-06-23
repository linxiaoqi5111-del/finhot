/**
 * Vite plugin that provides a `/api/rss/preview` endpoint for web-only mode.
 * Fetches and parses RSS/Atom feeds server-side to bypass CORS restrictions.
 *
 * Also provides:
 * - `/api/jina/read` — Jina Reader fallback for content extraction
 * - `/api/defuddle/read` — Defuddle content extraction (markdown)
 */
import { execFile } from "node:child_process"
import crypto from "node:crypto"

import { resolve as resolvePath } from "pathe"
import type { PluginOption } from "vite"

const RSS_FETCH_TIMEOUT_MS = 30_000
const RSS_ENTRY_LIMIT = 30
const JINA_READER_BASE = "https://r.jina.ai/"
const DEFUDDLE_BASE = "https://defuddle.md/"

/**
 * Fetch content via Jina Reader (r.jina.ai).
 * Returns markdown text of the page.
 */
async function fetchViaJina(url: string): Promise<string> {
  const jinaUrl = `${JINA_READER_BASE}${url}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RSS_FETCH_TIMEOUT_MS)

  const response = await fetch(jinaUrl, {
    signal: controller.signal,
    headers: {
      Accept: "text/plain",
      "X-Respond-With": "markdown",
    },
  })
  clearTimeout(timeout)

  if (!response.ok) {
    throw new Error(`Jina Reader HTTP ${response.status}: ${response.statusText}`)
  }
  return response.text()
}

/**
 * Fetch content via Defuddle (md.defuddle.com).
 * Returns markdown with YAML frontmatter.
 */
async function fetchViaDefuddle(url: string): Promise<string> {
  const defuddleUrl = `${DEFUDDLE_BASE}${url}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RSS_FETCH_TIMEOUT_MS)

  const response = await fetch(defuddleUrl, {
    signal: controller.signal,
    headers: { Accept: "text/plain" },
  })
  clearTimeout(timeout)

  if (!response.ok) {
    throw new Error(`Defuddle HTTP ${response.status}: ${response.statusText}`)
  }
  return response.text()
}

/**
 * For localhost RSSHub routes that fail, extract the actual platform URL
 * so we can try Jina as fallback on the real URL (not the localhost route).
 */
function extractPlatformUrl(rsshubUrl: string): string | null {
  const match = rsshubUrl.match(/localhost:\d+\/(.+)/)
  if (!match) return null
  const path = match[1]!

  // /weibo/user/{uid} → https://weibo.com/u/{uid}
  const weiboUser = path.match(/^weibo\/user\/(\d+)/)
  if (weiboUser) return `https://weibo.com/u/${weiboUser[1]}`

  // /weibo/search/hot → https://s.weibo.com/top/summary
  if (path === "weibo/search/hot") return "https://s.weibo.com/top/summary"

  // /xueqiu/user/{uid} → https://xueqiu.com/u/{uid}
  const xueqiuUser = path.match(/^xueqiu\/user\/(\d+)/)
  if (xueqiuUser) return `https://xueqiu.com/u/${xueqiuUser[1]}`

  // /xueqiu/hots → https://xueqiu.com/hots/topic
  if (path.startsWith("xueqiu/hots")) return "https://xueqiu.com/hots/topic"

  // /zhihu/people/activities/{id} → https://www.zhihu.com/people/{id}
  const zhihuPeople = path.match(/^zhihu\/people\/activities\/(.+)/)
  if (zhihuPeople) return `https://www.zhihu.com/people/${zhihuPeople[1]}`

  return null
}

/** Helper to read POST body as JSON */
async function readJsonBody(req: any): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"))
}

const SOGOU_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

/**
 * Resolve a WeChat public account name to its numeric biz ID.
 *
 * Pipeline:
 *  1. Sogou web search → temporary mp.weixin.qq.com article URLs
 *  2. Fetch article page → extract `var biz = "..."` (base64)
 *  3. Decode base64 → numeric biz ID
 */
interface ResolvedAccount {
  bizId: string
  nickname: string
  articleUrl: string
}

/** Extract biz ID and nickname from a WeChat article HTML page. */
function extractBizFromArticle(html: string): { bizId: string; nickname: string } | null {
  // Extract biz from `var biz = "MzYyMjU1NzM2OQ=="` pattern
  let bizId: string | null = null

  const bizMatch = /var\s+biz\s*=\s*["']([A-Za-z0-9=+/]+)["']/.exec(html)
  if (bizMatch) {
    const decoded = Buffer.from(bizMatch[1]!, "base64").toString("utf-8")
    if (/^\d+$/.test(decoded)) bizId = decoded
  }

  // Fallback: __biz parameter
  if (!bizId) {
    const bizParam = /__biz=([A-Za-z0-9=+/]+)/.exec(html)
    if (bizParam) {
      const decoded = Buffer.from(bizParam[1]!, "base64").toString("utf-8")
      if (/^\d+$/.test(decoded)) bizId = decoded
    }
  }

  if (!bizId) return null

  // Extract nickname: var nickname = htmlDecode("xxx") or var nickname = "xxx"
  let nickname = ""
  const nnMatch = /var\s+nickname\s*=\s*(?:htmlDecode\()?["']([^"']+)["']/.exec(html)
  if (nnMatch) nickname = nnMatch[1]!
  // Fallback: js_name element
  if (!nickname) {
    const jsName = /id=["']js_name["'][^>]*>\s*([^<\n]+)/.exec(html)
    if (jsName) nickname = jsName[1]!.trim()
  }

  return { bizId, nickname }
}

/**
 * Cookie-aware HTTP client for Sogou.
 * Sogou blocks requests without session cookies (anti-spider).
 * We warm up a session by visiting the appropriate domain first, then reuse
 * the Set-Cookie values on subsequent requests.
 */
const sogouSessions: Record<string, { cookies: string; expiry: number }> = {}

async function ensureSogouSession(domain: "www.sogou.com" | "weixin.sogou.com"): Promise<string> {
  const cached = sogouSessions[domain]
  if (cached && Date.now() < cached.expiry) return cached.cookies

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  try {
    const res = await fetch(`https://${domain}/`, {
      signal: controller.signal,
      headers: { "User-Agent": SOGOU_UA, Accept: "text/html" },
    })
    await res.text()

    const cookies: string[] = []
    const raw = res.headers.getSetCookie?.() ?? []
    for (const c of raw) {
      const kv = c.split(";")[0]
      if (kv) cookies.push(kv)
    }
    const cookieStr = cookies.join("; ")
    sogouSessions[domain] = { cookies: cookieStr, expiry: Date.now() + 10 * 60_000 }
    return cookieStr
  } finally {
    clearTimeout(timer)
  }
}

async function sogouFetch(
  url: string,
  options?: { timeoutMs?: number; domain?: "www.sogou.com" | "weixin.sogou.com" },
): Promise<string> {
  const { timeoutMs = 8_000, domain = "www.sogou.com" } = options ?? {}
  const cookies = await ensureSogouSession(domain)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": SOGOU_UA,
        Accept: "text/html",
        Cookie: cookies,
        Referer: `https://${domain}/`,
      },
    })

    // Accumulate new cookies from response to maintain full session state
    const newCookies = res.headers.getSetCookie?.() ?? []
    if (newCookies.length > 0) {
      const existing = new Map(
        cookies
          .split("; ")
          .filter(Boolean)
          .map((kv) => {
            const [k, ...rest] = kv.split("=")
            return [k!, rest.join("=")] as [string, string]
          }),
      )
      for (const c of newCookies) {
        const kv = c.split(";")[0]
        if (!kv) continue
        const [k, ...rest] = kv.split("=")
        if (k) existing.set(k, rest.join("="))
      }
      const merged = [...existing.entries()].map(([k, v]) => `${k}=${v}`).join("; ")
      const cached = sogouSessions[domain]
      if (cached) cached.cookies = merged
    }

    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/** Fetch a URL without Sogou session cookies (for mp.weixin.qq.com articles). */
async function plainFetch(url: string, timeoutMs = 6_000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": SOGOU_UA, Accept: "text/html" },
    })
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * PRIMARY strategy: Search weixin.sogou.com article search (type=2).
 *
 * This endpoint returns Sogou redirect links rather than direct mp.weixin URLs.
 * Each redirect link leads to an intermediate page whose JS reconstructs the
 * actual article URL via string concatenation:
 *   url += 'https://mp.'; url += 'weixin.qq.c'; url += 'om/s?src=11'; ...
 *
 * We fetch the intermediate page, parse the concatenated URL, then fetch the
 * real article to extract biz ID + nickname.
 */
/** Resolve a single Sogou redirect link → article → biz ID + nickname. */
async function resolveOneRedirect(rlink: string): Promise<ResolvedAccount | null> {
  // Fetch the Sogou intermediate redirect page
  const rpage = await sogouFetch(`https://weixin.sogou.com${rlink}`, {
    timeoutMs: 6_000,
    domain: "weixin.sogou.com",
  })

  // Parse actual article URL from JS string concatenation
  const urlParts = [...rpage.matchAll(/url\s*\+=\s*'([^']*)'/g)].map((m) => m[1]!)
  if (urlParts.length === 0) return null
  const articleUrl = urlParts.join("")
  if (!articleUrl.includes("mp.weixin.qq.com")) return null

  // Fetch the real article page (plain fetch, no Sogou cookies/referer)
  // Articles can be 3+ MB and take ~6-8s on a typical connection
  const articleHtml = await plainFetch(articleUrl, 15_000)
  const extracted = extractBizFromArticle(articleHtml)
  if (!extracted) return null

  return { bizId: extracted.bizId, nickname: extracted.nickname, articleUrl }
}

async function weixinSogouArticleSearch(
  name: string,
  nameLower: string,
): Promise<ResolvedAccount | null> {
  const searchUrl = `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(name)}&ie=utf8`
  const html = await sogouFetch(searchUrl, { domain: "weixin.sogou.com" })

  // Extract Sogou redirect links from the search results page
  const redirectLinks = [...html.matchAll(/href="(\/link\?url=[^"]+)"/g)].map((m) => m[1]!)
  if (redirectLinks.length === 0) return null

  // Process up to 3 redirects in PARALLEL, return on first exact match
  let bestMatch: ResolvedAccount | null = null

  return new Promise<ResolvedAccount | null>((resolve) => {
    let pending = Math.min(redirectLinks.length, 3)
    let resolved = false

    for (const rlink of redirectLinks.slice(0, 3)) {
      resolveOneRedirect(rlink)
        .then((result) => {
          if (resolved) return
          if (result) {
            const nn = result.nickname.toLowerCase()
            if (nn === nameLower) {
              resolved = true
              resolve(result)
              return
            }
            if (!bestMatch && (nn.includes(nameLower) || nameLower.includes(nn))) {
              bestMatch = result
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          pending--
          if (!resolved && pending <= 0) {
            resolved = true
            resolve(bestMatch)
          }
        })
    }
  })
}

/**
 * FALLBACK strategy: regular Sogou web search for mp.weixin.qq.com articles.
 */
async function sogouWebSearch(name: string, nameLower: string): Promise<ResolvedAccount | null> {
  let bestMatch: ResolvedAccount | null = null

  for (const query of [
    `"${name}" site:mp.weixin.qq.com`,
    `${name} 微信公众号 site:mp.weixin.qq.com`,
  ]) {
    try {
      const html = await sogouFetch(`https://www.sogou.com/web?query=${encodeURIComponent(query)}`)
      const decoded = html.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
      const urls = [
        ...new Set(
          [...decoded.matchAll(/https?:\/\/mp\.weixin\.qq\.com\/s\?[^"<>\s]+/g)].map((m) => m[0]),
        ),
      ]

      for (const articleUrl of urls.slice(0, 3)) {
        try {
          const articleHtml = await plainFetch(articleUrl, 6_000)
          const extracted = extractBizFromArticle(articleHtml)
          if (!extracted) continue

          const candidate: ResolvedAccount = {
            bizId: extracted.bizId,
            nickname: extracted.nickname,
            articleUrl,
          }

          if (extracted.nickname.toLowerCase() === nameLower) return candidate

          if (
            !bestMatch &&
            extracted.nickname &&
            (extracted.nickname.toLowerCase().includes(nameLower) ||
              nameLower.includes(extracted.nickname.toLowerCase()))
          ) {
            bestMatch = candidate
          }
        } catch {
          continue
        }
      }
      if (bestMatch) return bestMatch
    } catch {
      continue
    }
  }

  return bestMatch
}

async function resolveWechatBizId(name: string): Promise<ResolvedAccount | null> {
  const nameLower = name.toLowerCase()

  // Race against 20-second deadline for quick user feedback
  const deadline = new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000))

  const search = (async () => {
    // 1) Primary: weixin.sogou.com article search with redirect extraction
    const primary = await weixinSogouArticleSearch(name, nameLower)
    if (primary) return primary

    // 2) Fallback: regular Sogou web search
    return sogouWebSearch(name, nameLower)
  })()

  return Promise.race([search, deadline])
}

/** CORS preflight helper */
function handleCors(req: any, res: any): boolean {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    })
    res.end()
    return true
  }
  return false
}

// ─── Xueqiu scraper via Playwright (WAF bypass) ───
// Xueqiu uses Aliyun WAF that blocks all non-browser HTTP clients.
// We spawn a headful Chrome via Playwright to solve the WAF challenge,
// then fetch the user timeline API from within the browser context.

const xueqiuCache = new Map<string, { data: any; expiry: number }>()
// Smart cache TTL: 1 hour during trading, 5 hours outside trading
function getXueqiuCacheTTL(): number {
  const now = new Date()
  const hour = now.getHours()
  const minute = now.getMinutes()
  const timeInMinutes = hour * 60 + minute
  const day = now.getDay()
  const isWeekday = day >= 1 && day <= 5
  const isTradingHours = isWeekday && timeInMinutes >= 570 && timeInMinutes <= 900 // 9:30-15:00
  return isTradingHours ? 60 * 60_000 : 5 * 60 * 60_000 // 1h or 5h
}

function resolveXueqiuUserId(url: string): string | null {
  // finhot://xueqiu/{userId}
  const finhotMatch = /^finhot:\/\/xueqiu\/(\d+)$/.exec(url)
  if (finhotMatch) return finhotMatch[1]!

  // https://xueqiu.com/u/{userId}
  try {
    const parsed = new URL(url)
    if (parsed.hostname === "xueqiu.com") {
      const seg = parsed.pathname.match(/^\/u\/(\d+)/)
      if (seg) return seg[1]!
    }
  } catch {
    /* not a URL */
  }

  return null
}

async function fetchXueqiuTimeline(
  userId: string,
): Promise<{ statuses: any[]; screenName: string }> {
  const cached = xueqiuCache.get(userId)
  if (cached && Date.now() < cached.expiry) return cached.data

  const scraperPath = resolvePath(import.meta.dirname, "xueqiu-scraper.mjs")
  const result = await new Promise<string>((resolve, reject) => {
    execFile(
      "node",
      [scraperPath, userId],
      {
        timeout: 60_000,
        maxBuffer: 5 * 1024 * 1024,
        env: { ...process.env, NODE_PATH: resolvePath(import.meta.dirname, "../../node_modules") },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message))
        } else {
          resolve(stdout)
        }
      },
    )
  })

  const parsed = JSON.parse(result)
  const data = {
    statuses: parsed.statuses ?? [],
    screenName: parsed.screenName ?? userId,
  }
  xueqiuCache.set(userId, { data, expiry: Date.now() + getXueqiuCacheTTL() })
  return data
}

function xueqiuTimelineToFeed(userId: string, screenName: string, statuses: any[], limit: number) {
  const feedUrl = `finhot://xueqiu/${userId}`
  const feedId = generateId(feedUrl)

  const feed = {
    id: feedId,
    title: `${screenName} - 雪球`,
    url: feedUrl,
    description: `雪球用户 ${screenName} 的动态`,
    image: null,
    errorAt: null,
    siteUrl: `https://xueqiu.com/u/${userId}`,
    ownerUserId: null,
    errorMessage: null,
    subscriptionCount: null,
    updatesPerWeek: null,
    latestEntryPublishedAt: null,
    tipUserIds: null as string[] | null,
    updatedAt: new Date().toISOString(),
  }

  const entries = statuses.slice(0, limit).map((s: any) => {
    const title =
      s.title || (s.description ? stripHtml(s.description).slice(0, 80) : `动态 ${s.id}`)
    const link = `https://xueqiu.com${s.target || `/${userId}/${s.id}`}`
    const content = s.text || s.description || ""
    const publishedAt = s.created_at
      ? new Date(s.created_at).toISOString()
      : new Date().toISOString()
    const entryId = generateId(`${feedUrl}::${s.id}`)

    let retweetBlock = ""
    if (s.retweeted_status) {
      const rt = s.retweeted_status
      retweetBlock = `<blockquote>${rt.user?.screen_name ?? ""}: ${rt.description ?? ""}</blockquote>`
    }

    return {
      id: entryId,
      title: title || null,
      url: link,
      content: stripHtml(content + retweetBlock),
      readabilityContent: null,
      readabilityUpdatedAt: null,
      description: stripHtml(content).slice(0, 300) || null,
      guid: String(s.id),
      author: screenName,
      authorUrl: `https://xueqiu.com/u/${userId}`,
      authorAvatar: null,
      insertedAt: new Date().toISOString(),
      publishedAt,
      media: null,
      categories: null,
      attachments: null,
      extra: null,
      language: "zh-CN",
      feedId,
      inboxHandle: null,
      read: false,
      sources: null,
      settings: null,
    }
  })

  return { feed, entries }
}

/**
 * Nitter instance hostnames used for Twitter RSS fallback.
 * Entry links from these domains are normalized back to x.com.
 */
const NITTER_HOSTS = new Set(["xcancel.com", "nitter.net", "nitter.privacyredirect.com", "nitter.tiekoetter.com"])

/**
 * Normalize Nitter entry URLs back to x.com.
 * e.g. https://xcancel.com/user/status/123#m -> https://x.com/user/status/123
 */
function normalizeNitterUrl(link: string | null): string | null {
  if (!link) return null
  try {
    const parsed = new URL(link)
    if (NITTER_HOSTS.has(parsed.hostname)) {
      return `https://x.com${parsed.pathname.split("#")[0]}`
    }
  } catch {
    /* not a URL */
  }
  return link
}

/**
 * Resolve a URL that should be handled by the built-in Twitter-to-RSS converter.
 * Returns the Twitter screen_name if matched, null otherwise.
 *
 * Matched patterns:
 *  - finhot://twitter/{screenName}
 *  - https://x.com/{screenName}
 *  - https://twitter.com/{screenName}
 */
function resolveTwitterScreenName(url: string): string | null {
  const finhotMatch = /^finhot:\/\/twitter\/(\w+)$/.exec(url)
  if (finhotMatch) return finhotMatch[1]!

  try {
    const parsed = new URL(url)
    if (parsed.hostname === "x.com" || parsed.hostname === "twitter.com") {
      const seg = parsed.pathname.replace(/^\//, "").split("/")[0]
      if (seg && /^\w+$/.test(seg)) return seg
    }
  } catch {
    /* not a URL */
  }

  return null
}

export function rssProxyPlugin(): PluginOption {
  return {
    name: "rss-proxy",
    configureServer(server) {
      // ─── /api/rss/preview — RSS fetch with Jina fallback ───
      server.middlewares.use("/api/rss/preview", async (req, res) => {
        if (handleCors(req, res)) return

        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }

        const body = await readJsonBody(req)
        const { url, lite, limit } = body as { url: string; lite?: boolean; limit?: number }

        if (!url) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "url is required" }))
          return
        }

        try {
          // Built-in Xueqiu scraper: bypass WAF via headful Playwright
          const xueqiuUserId = resolveXueqiuUserId(url)
          if (xueqiuUserId) {
            try {
              const { statuses, screenName } = await fetchXueqiuTimeline(xueqiuUserId)
              const result = xueqiuTimelineToFeed(
                xueqiuUserId,
                screenName,
                statuses,
                limit ?? RSS_ENTRY_LIMIT,
              )
              res.writeHead(200, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              })
              res.end(JSON.stringify(result))
              return
            } catch (xqError: unknown) {
              const xqMsg = xqError instanceof Error ? xqError.message : "Xueqiu fetch failed"
              res.writeHead(502, { "Content-Type": "application/json" })
              res.end(JSON.stringify({ error: xqMsg }))
              return
            }
          }

          // Built-in Twitter-to-RSS: try Nitter instances first, then RSSHub
          const twitterHandle = resolveTwitterScreenName(url)
          if (twitterHandle) {
            const twitterRssSources: { url: string; ua?: string }[] = [
              // Local RSSHub (fastest when available)
              { url: `http://localhost:1200/twitter/user/${twitterHandle}` },
              // Nitter/xcancel instances (free, no RSSHub dependency)
              { url: `https://xcancel.com/${twitterHandle}/rss`, ua: "FreshRSS/1.24.0 (Linux; https://freshrss.org)" },
              { url: `https://nitter.privacyredirect.com/${twitterHandle}/rss`, ua: "FreshRSS/1.24.0 (Linux; https://freshrss.org)" },
              // Public RSSHub instances
              { url: `https://rsshub.bestblogs.dev/twitter/user/${twitterHandle}` },
              { url: `https://rsshub.app/twitter/user/${twitterHandle}` },
            ]

            let xml: string | null = null
            for (const source of twitterRssSources) {
              try {
                const controller = new AbortController()
                const timeout = setTimeout(() => controller.abort(), 10_000)
                const rsshubRes = await fetch(source.url, {
                  signal: controller.signal,
                  headers: {
                    Accept: "application/rss+xml, application/xml, text/xml",
                    ...(source.ua ? { "User-Agent": source.ua } : {}),
                  },
                })
                clearTimeout(timeout)
                if (rsshubRes.ok) {
                  const text = await rsshubRes.text()
                  if (text.includes("<rss") || text.includes("<feed") || text.includes("<?xml")) {
                    xml = text
                    break
                  }
                }
              } catch {
                continue
              }
            }

            if (!xml) {
              throw new Error(
                `Twitter RSS 暂不可用：所有 Nitter 实例和 RSSHub 公共实例均无法访问。请启动本地 RSSHub (localhost:1200) 或稍后重试。`,
              )
            }

            const feedUrl = `finhot://twitter/${twitterHandle}`
            const result = parseRssFeed(xml, feedUrl, limit ?? RSS_ENTRY_LIMIT)
            // Normalize Nitter URLs back to x.com in parsed entries
            for (const entry of result.entries) {
              entry.url = normalizeNitterUrl(entry.url)
            }
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            })
            res.end(JSON.stringify(result))
            return
          }

          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), RSS_FETCH_TIMEOUT_MS)

          const response = await fetch(url, {
            signal: controller.signal,
            headers: {
              "User-Agent": "FinHot/0.1.4 (RSS Reader)",
              Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
            },
          })
          clearTimeout(timeout)

          if (!response.ok) {
            if (response.status >= 500) {
              // For localhost RSSHub routes, try Jina on the real platform URL
              const isLocal = /^https?:\/\/(?:localhost|127\.0\.0\.1)/i.test(url)
              const fallbackUrl = isLocal ? extractPlatformUrl(url) : url
              if (fallbackUrl) {
                const jinaContent = await fetchViaJina(fallbackUrl)
                const fallbackResult = buildFallbackResult(url, jinaContent)
                res.writeHead(200, {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                })
                res.end(JSON.stringify(fallbackResult))
                return
              }
            }
            throw new Error(`HTTP ${response.status}: ${response.statusText}`)
          }

          const xml = await response.text()
          const result = parseRssFeed(xml, url, limit ?? (lite ? 8 : RSS_ENTRY_LIMIT))

          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(JSON.stringify(result))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          // Try Jina fallback: for localhost routes use real platform URL, otherwise use the URL directly
          const isLocal = /^https?:\/\/(?:localhost|127\.0\.0\.1)/i.test(url)
          const fallbackUrl = isLocal ? extractPlatformUrl(url) : url
          if (fallbackUrl) {
            try {
              const jinaContent = await fetchViaJina(fallbackUrl)
              const fallbackResult = buildFallbackResult(url, jinaContent)
              res.writeHead(200, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              })
              res.end(JSON.stringify(fallbackResult))
              return
            } catch {
              // Jina also failed, fall through to error response
            }
          }
          res.writeHead(502, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })

      // ─── /api/rss/proxy-html — Fetch raw HTML for feed auto-discovery ───
      server.middlewares.use("/api/rss/proxy-html", async (req, res) => {
        if (handleCors(req, res)) return

        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }

        const body = await readJsonBody(req)
        const { url } = body as { url: string }

        if (!url) {
          res.writeHead(400, { "Content-Type": "text/plain" })
          res.end("url is required")
          return
        }

        try {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), RSS_FETCH_TIMEOUT_MS)

          const response = await fetch(url, {
            signal: controller.signal,
            headers: {
              "User-Agent": "FinHot/0.1.4 (RSS Reader)",
              Accept: "text/html, application/xhtml+xml, */*",
            },
          })
          clearTimeout(timeout)

          if (!response.ok) {
            res.writeHead(response.status, { "Content-Type": "text/plain" })
            res.end(`HTTP ${response.status}`)
            return
          }

          const html = await response.text()
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(html)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(502, { "Content-Type": "text/plain" })
          res.end(message)
        }
      })

      // ─── /api/jina/read — Direct Jina Reader endpoint ───
      server.middlewares.use("/api/jina/read", async (req, res) => {
        if (handleCors(req, res)) return

        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }

        const body = await readJsonBody(req)
        const { url } = body as { url: string }

        if (!url) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "url is required" }))
          return
        }

        try {
          const content = await fetchViaJina(url)
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(JSON.stringify({ url, content, source: "jina" }))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(502, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })

      // ─── /api/defuddle/read — Defuddle content extraction ───
      server.middlewares.use("/api/defuddle/read", async (req, res) => {
        if (handleCors(req, res)) return

        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }

        const body = await readJsonBody(req)
        const { url } = body as { url: string }

        if (!url) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "url is required" }))
          return
        }

        try {
          const content = await fetchViaDefuddle(url)
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(JSON.stringify({ url, content, source: "defuddle" }))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(502, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })

      // ─── /api/wechat2rss/resolve-name — Resolve account name → biz ID ───
      // Searches Sogou for articles, extracts biz from the article page JS.
      server.middlewares.use("/api/wechat2rss/resolve-name", async (req, res) => {
        if (handleCors(req, res)) return

        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }

        const body = await readJsonBody(req)
        const { name } = body as { name: string }

        if (!name) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "name is required" }))
          return
        }

        try {
          const result = await resolveWechatBizId(name)
          if (!result) {
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            })
            res.end(JSON.stringify({ found: false }))
            return
          }

          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(
            JSON.stringify({
              found: true,
              bizId: result.bizId,
              nickname: result.nickname,
              articleUrl: result.articleUrl,
            }),
          )
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(502, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })

      // ─── /api/embedding/proxy — Server-side proxy for embedding API ───
      // Bypasses CORS restrictions when calling external embedding providers from web mode.
      server.middlewares.use("/api/embedding/proxy", async (req, res) => {
        if (handleCors(req, res)) return

        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }

        const body = await readJsonBody(req)
        const { baseURL, apiKey, payload } = body as {
          baseURL: string
          apiKey: string
          payload: Record<string, unknown>
        }

        if (!baseURL || !apiKey || !payload) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "baseURL, apiKey, and payload are required" }))
          return
        }

        try {
          const endpoint = `${baseURL.replace(/\/+$/, "")}/embeddings`
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 30_000)

          const response = await fetch(endpoint, {
            method: "POST",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          })
          clearTimeout(timeout)

          const text = await response.text()
          res.writeHead(response.status, {
            "Content-Type": response.headers.get("content-type") ?? "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(text)
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(502, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })

      // ─── /api/wechat2rss/proxy — Server-side proxy for wechat2rss API ───
      // Bypasses CORS restrictions when the browser calls a local wechat2rss instance.
      server.middlewares.use("/api/wechat2rss/proxy", async (req, res) => {
        if (handleCors(req, res)) return

        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }

        const body = await readJsonBody(req)
        const { url } = body as { url: string }

        if (!url) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "url is required" }))
          return
        }

        try {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), RSS_FETCH_TIMEOUT_MS)

          const response = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: "application/json" },
          })
          clearTimeout(timeout)

          const text = await response.text()
          res.writeHead(response.status, {
            "Content-Type": response.headers.get("content-type") ?? "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(text)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(502, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })
    },
  }
}

/**
 * Build a minimal RSS preview result from raw text content (Jina/Defuddle fallback).
 * Creates a single-entry feed so the subscription system can still process it.
 */
function buildFallbackResult(url: string, content: string) {
  const feedId = generateId(url)
  // Try to extract title from first line of markdown
  const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? url
  const title = firstLine.replace(/^#+\s*/, "").slice(0, 100)

  const feed = {
    id: feedId,
    title: title || url,
    url,
    description: `Content fetched via Jina Reader fallback`,
    image: null,
    errorAt: null,
    siteUrl: url,
    ownerUserId: null,
    errorMessage: null,
    subscriptionCount: null,
    updatesPerWeek: null,
    latestEntryPublishedAt: null,
    tipUserIds: null as string[] | null,
    updatedAt: new Date().toISOString(),
  }

  const entryId = generateId(`${url}::fallback::${Date.now()}`)
  const entries = [
    {
      id: entryId,
      title: title || null,
      url,
      content: content.slice(0, 5000),
      readabilityContent: null,
      readabilityUpdatedAt: null,
      description: content.slice(0, 300),
      guid: entryId,
      author: null,
      authorUrl: null,
      authorAvatar: null,
      insertedAt: new Date().toISOString(),
      publishedAt: new Date().toISOString(),
      media: null,
      categories: null,
      attachments: null,
      extra: null,
      language: null,
      feedId,
      inboxHandle: null,
      read: false,
      sources: null,
      settings: null,
    },
  ]

  return { feed, entries }
}

function generateId(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 32)
}

function parseRssFeed(xml: string, feedUrl: string, limit: number) {
  const isAtom = xml.includes("<feed") && xml.includes('xmlns="http://www.w3.org/2005/Atom"')

  const feedTitle = extractTag(xml, isAtom ? "title" : "title") ?? feedUrl
  const feedDescription = extractTag(xml, isAtom ? "subtitle" : "description") ?? null
  const feedLink = extractTag(xml, isAtom ? "id" : "link") ?? feedUrl
  const feedImage = extractTag(xml, "image>url") ?? extractAttr(xml, "image", "href") ?? null

  const feed = {
    id: generateId(feedUrl),
    title: feedTitle ?? null,
    url: feedUrl,
    description: feedDescription ?? null,
    image: feedImage ?? null,
    errorAt: null,
    siteUrl: feedLink ?? null,
    ownerUserId: null,
    errorMessage: null,
    subscriptionCount: null,
    updatesPerWeek: null,
    latestEntryPublishedAt: null,
    tipUserIds: null as string[] | null,
    updatedAt: new Date().toISOString(),
  }

  const entries = parseEntries(xml, isAtom, feedUrl, limit)

  return { feed, entries }
}

const URL_RE = /^https?:\/\//i

/**
 * Pre-filter: detect obviously low-quality entries that should be hidden.
 * Catches: URL-only titles with no body, completely empty entries,
 * title that is just a duplicate of the link URL.
 */
function isLowQualityEntry(entry: {
  title: string | null
  url: string | null
  content: string
  description: string | null
}): boolean {
  const title = (entry.title ?? "").trim()
  const body = [entry.content, entry.description ?? ""].join(" ").replaceAll(/\s+/g, " ").trim()

  // Completely empty: no title and no body
  if (!title && body.length < 10) return true

  // Title is a bare URL and body is empty/very short
  if (URL_RE.test(title) && body.length < 30) return true

  // Title is identical to the entry URL (just a link, no real title)
  if (entry.url && title === entry.url && body.length < 30) return true

  // Body is just the URL repeated
  if (entry.url && body === entry.url) return true

  return false
}

function parseEntries(xml: string, isAtom: boolean, feedUrl: string, limit: number) {
  const itemTag = isAtom ? "entry" : "item"
  const regex = new RegExp(`<${itemTag}[\\s>][\\s\\S]*?</${itemTag}>`, "gi")
  const items = xml.match(regex) ?? []

  return items
    .slice(0, limit)
    .map((item) => {
      const title = extractTag(item, "title") ?? ""
      const link = isAtom
        ? (extractAttr(item, "link", "href") ?? extractTag(item, "link"))
        : extractTag(item, "link")
      const pubDate =
        extractTag(item, isAtom ? "published" : "pubDate") ??
        extractTag(item, isAtom ? "updated" : "dc:date")
      const description = extractTag(item, isAtom ? "summary" : "description") ?? ""
      const content =
        extractTag(item, "content:encoded") ?? extractTag(item, "content") ?? description
      const author = extractTag(item, isAtom ? "name" : "dc:creator") ?? extractTag(item, "author")

      const guid = extractTag(item, isAtom ? "id" : "guid") ?? link ?? title
      const id = generateId(`${feedUrl}::${guid}`)
      const publishedAt = pubDate ? new Date(pubDate).toISOString() : new Date().toISOString()

      return {
        id,
        title: title || null,
        url: link ?? null,
        content: stripHtml(content),
        readabilityContent: null,
        readabilityUpdatedAt: null,
        description: stripHtml(description).slice(0, 300) || null,
        guid: guid ?? id,
        author: author ?? null,
        authorUrl: null,
        authorAvatar: null,
        insertedAt: new Date().toISOString(),
        publishedAt,
        media: null,
        categories: null,
        attachments: null,
        extra: null,
        language: null,
        feedId: generateId(feedUrl),
        inboxHandle: null,
        read: false,
        sources: null,
        settings: null,
      }
    })
    .filter((entry) => !isLowQualityEntry(entry))
}

function extractTag(xml: string, tag: string): string | null {
  // Handle CDATA
  const cdataRegex = new RegExp(
    `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`,
    "i",
  )
  const cdataMatch = xml.match(cdataRegex)
  if (cdataMatch) return cdataMatch[1].trim()

  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i")
  const match = xml.match(regex)
  return match ? decodeHtmlEntities(match[1].trim()) : null
}

function extractAttr(xml: string, tag: string, attr: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, "i")
  const match = xml.match(regex)
  return match ? match[1] : null
}

function stripHtml(html: string): string {
  return html
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll(/\s+/g, " ")
    .trim()
}

function decodeHtmlEntities(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 10)))
}
