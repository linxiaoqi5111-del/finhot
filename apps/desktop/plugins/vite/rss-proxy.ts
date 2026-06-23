/**
 * Vite plugin that provides a `/api/rss/preview` endpoint for web-only mode.
 * Fetches and parses RSS/Atom feeds server-side to bypass CORS restrictions.
 *
 * Also provides:
 * - `/api/jina/read` — Jina Reader fallback for content extraction
 * - `/api/defuddle/read` — Defuddle content extraction (markdown)
 * - `/api/public/subscriptions` — Public read-only feed list
 * - `/api/public/entries` — Public read-only entries
 */
import { execFile } from "node:child_process"
import crypto from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

import { join, resolve as resolvePath } from "pathe"
import type { PluginOption } from "vite"

const RSS_FETCH_TIMEOUT_MS = 30_000
const RSS_ENTRY_LIMIT = 30
const JINA_READER_BASE = "https://r.jina.ai/"
const DEFUDDLE_BASE = "https://defuddle.md/"

// ─── Public feed cache (server-side persistence for visitor mode) ───

interface CachedFeed {
  id: string
  title: string | null
  url: string
  description: string | null
  image: string | null
  siteUrl: string | null
  category: string | null
  updatedAt: string
}

interface CachedEntry {
  id: string
  title: string | null
  url: string | null
  content: string
  description: string | null
  author: string | null
  publishedAt: string
  feedId: string
}

interface CachedEnrichment {
  summary?: string | null
  tags?: string[]
  qualityScore?: number | null
  qualityTier?: string | null
  embedding?: number[]
}

type EnrichmentMap = Record<string, CachedEnrichment>

interface FeedCacheManifest {
  feeds: Record<string, CachedFeed>
  updatedAt: string
}

let cacheDir = ""

function ensureCacheDir(rootDir: string) {
  if (cacheDir) return cacheDir
  cacheDir = join(rootDir, ".finhot-cache")
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
  const entriesDir = join(cacheDir, "entries")
  if (!existsSync(entriesDir)) mkdirSync(entriesDir, { recursive: true })
  return cacheDir
}

function readEnrichments(): EnrichmentMap {
  const file = join(cacheDir, "enrichments.json")
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, "utf-8"))
  } catch {
    return {}
  }
}

function writeEnrichments(data: EnrichmentMap) {
  writeFileSync(join(cacheDir, "enrichments.json"), JSON.stringify(data))
}

function readManifest(): FeedCacheManifest {
  const file = join(cacheDir, "manifest.json")
  if (!existsSync(file)) return { feeds: {}, updatedAt: new Date().toISOString() }
  try {
    return JSON.parse(readFileSync(file, "utf-8"))
  } catch {
    return { feeds: {}, updatedAt: new Date().toISOString() }
  }
}

function writeManifest(manifest: FeedCacheManifest) {
  writeFileSync(join(cacheDir, "manifest.json"), JSON.stringify(manifest, null, 2))
}

function cacheFeedResult(
  feedData: {
    id: string
    title: string | null
    url: string
    description: string | null
    image: string | null
    siteUrl: string | null
  },
  entries: {
    id: string
    title: string | null
    url: string | null
    content: string
    description: string | null
    author: string | null
    publishedAt: string
    feedId: string
  }[],
  category?: string | null,
) {
  if (!cacheDir) return
  try {
    const manifest = readManifest()
    manifest.feeds[feedData.id] = {
      id: feedData.id,
      title: feedData.title,
      url: feedData.url,
      description: feedData.description,
      image: feedData.image,
      siteUrl: feedData.siteUrl,
      category: category ?? manifest.feeds[feedData.id]?.category ?? null,
      updatedAt: new Date().toISOString(),
    }
    manifest.updatedAt = new Date().toISOString()
    writeManifest(manifest)

    // Merge new entries with existing, keep latest by publishedAt, cap at RSS_ENTRY_LIMIT
    const entriesFile = join(cacheDir, "entries", `${feedData.id}.json`)
    let existing: CachedEntry[] = []
    if (existsSync(entriesFile)) {
      try {
        existing = JSON.parse(readFileSync(entriesFile, "utf-8"))
      } catch {
        /* ignore */
      }
    }
    const byId = new Map<string, CachedEntry>()
    for (const e of existing) byId.set(e.id, e)
    for (const e of entries)
      byId.set(e.id, {
        id: e.id,
        title: e.title,
        url: e.url,
        content: e.content,
        description: e.description,
        author: e.author,
        publishedAt: e.publishedAt,
        feedId: e.feedId,
      })
    const merged = [...byId.values()]
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      .slice(0, RSS_ENTRY_LIMIT * 2)
    writeFileSync(entriesFile, JSON.stringify(merged, null, 2))
  } catch {
    // Cache write failure should never break the main flow
  }
}

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
const NITTER_HOSTS = new Set([
  "xcancel.com",
  "nitter.net",
  "nitter.privacyredirect.com",
  "nitter.tiekoetter.com",
])

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
      // Initialize the public feed cache directory
      const rootDir = server.config.root ? resolvePath(server.config.root, "../..") : process.cwd()
      ensureCacheDir(rootDir)

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
              cacheFeedResult(result.feed, result.entries, "雪球")
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

          // Built-in Twitter-to-RSS: try Nitter instances first (most reliable), then RSSHub
          const twitterHandle = resolveTwitterScreenName(url)
          if (twitterHandle) {
            const FRESHRSS_UA = "FreshRSS/1.24.0 (Linux; https://freshrss.org)"
            const twitterRssSources: { url: string; ua?: string }[] = [
              // Nitter/xcancel instances — primary, most reliable for Twitter RSS
              { url: `https://xcancel.com/${twitterHandle}/rss`, ua: FRESHRSS_UA },
              { url: `https://nitter.privacyredirect.com/${twitterHandle}/rss`, ua: FRESHRSS_UA },
              // Local RSSHub (when running)
              { url: `http://localhost:1200/twitter/user/${twitterHandle}` },
              // Public RSSHub instances (least reliable for Twitter)
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
                  const isXml =
                    text.includes("<rss") || text.includes("<feed") || text.includes("<?xml")
                  // Reject responses that look like XML but contain known error markers
                  const hasErrorMarker = /not yet whitelisted|Rate limit|suspended/i.test(text)
                  if (isXml && !hasErrorMarker) {
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
            cacheFeedResult(result.feed, result.entries, "推特")
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

          // Infer category from URL for cache
          const feedCategory = /xueqiu/i.test(url)
            ? "雪球"
            : /weibo/i.test(url)
              ? "微博"
              : /mp\.weixin/i.test(url)
                ? "公众号"
                : null
          cacheFeedResult(result.feed, result.entries, feedCategory)

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

      // ─── /api/public/subscriptions — Read-only feed list for visitors ───
      server.middlewares.use("/api/public/subscriptions", async (req, res) => {
        if (handleCors(req, res)) return
        if (req.method !== "GET") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }
        try {
          const manifest = readManifest()
          const feeds = Object.values(manifest.feeds).sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
          )
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=60",
          })
          res.end(JSON.stringify({ feeds, updatedAt: manifest.updatedAt }))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })

      // ─── /api/public/entries — Read-only entries for visitors ───
      server.middlewares.use("/api/public/entries", async (req, res) => {
        if (handleCors(req, res)) return
        if (req.method !== "GET") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }
        try {
          const parsedUrl = new URL(req.url ?? "/", "http://localhost")
          const feedId = parsedUrl.searchParams.get("feedId")
          const limitParam = parsedUrl.searchParams.get("limit")
          const entryLimit = limitParam ? Number.parseInt(limitParam, 10) : 50

          if (feedId) {
            // Single feed's entries
            const entriesFile = join(cacheDir, "entries", `${feedId}.json`)
            if (!existsSync(entriesFile)) {
              res.writeHead(200, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              })
              res.end(JSON.stringify({ entries: [] }))
              return
            }
            const entries: CachedEntry[] = JSON.parse(readFileSync(entriesFile, "utf-8"))
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=60",
            })
            res.end(JSON.stringify({ entries: entries.slice(0, entryLimit) }))
          } else {
            // All entries across all feeds, sorted by publishedAt
            const manifest = readManifest()
            const allEntries: CachedEntry[] = []
            for (const feedKey of Object.keys(manifest.feeds)) {
              const entriesFile = join(cacheDir, "entries", `${feedKey}.json`)
              if (!existsSync(entriesFile)) continue
              try {
                const feedEntries: CachedEntry[] = JSON.parse(readFileSync(entriesFile, "utf-8"))
                allEntries.push(...feedEntries)
              } catch {
                /* skip corrupted files */
              }
            }
            allEntries.sort(
              (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
            )
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=60",
            })
            res.end(JSON.stringify({ entries: allEntries.slice(0, entryLimit) }))
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })

      // ─── /api/public/feed-with-entries — Single feed + its entries (convenience) ───
      server.middlewares.use("/api/public/feed-with-entries", async (req, res) => {
        if (handleCors(req, res)) return
        if (req.method !== "GET") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }
        try {
          const manifest = readManifest()
          const feeds = Object.values(manifest.feeds)
          const result: { feed: CachedFeed; entries: CachedEntry[] }[] = []
          for (const feed of feeds) {
            const entriesFile = join(cacheDir, "entries", `${feed.id}.json`)
            let entries: CachedEntry[] = []
            if (existsSync(entriesFile)) {
              try {
                entries = JSON.parse(readFileSync(entriesFile, "utf-8"))
              } catch {
                /* skip */
              }
            }
            result.push({ feed, entries: entries.slice(0, 5) })
          }
          result.sort(
            (a, b) => new Date(b.feed.updatedAt).getTime() - new Date(a.feed.updatedAt).getTime(),
          )
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=60",
          })
          res.end(JSON.stringify({ data: result, updatedAt: manifest.updatedAt }))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })

      // ─── /public — Self-contained public reader HTML (no Vite modules needed) ───
      server.middlewares.use("/public", async (_req, res) => {
        const manifest = readManifest()
        const feeds = Object.values(manifest.feeds).sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )
        // Pre-load all entries
        const entriesByFeed: Record<string, CachedEntry[]> = {}
        for (const feed of feeds) {
          const entriesFile = join(cacheDir, "entries", `${feed.id}.json`)
          if (existsSync(entriesFile)) {
            try {
              entriesByFeed[feed.id] = JSON.parse(readFileSync(entriesFile, "utf-8"))
            } catch {
              /* skip */
            }
          }
        }
        const allEntries = Object.values(entriesByFeed)
          .flat()
          .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
          .slice(0, 500)

        const enrichments = readEnrichments()
        // Strip embeddings from enrichments to reduce page size (only used for clustering)
        const enrichmentsForPage: Record<string, any> = {}
        for (const [id, en] of Object.entries(enrichments)) {
          const { embedding, ...rest } = en as any
          enrichmentsForPage[id] = rest
          if (embedding) enrichmentsForPage[id].embedding = embedding
        }
        const feedsJson = JSON.stringify(feeds)
        const entriesByFeedJson = JSON.stringify(entriesByFeed)
        const allEntriesJson = JSON.stringify(allEntries)
        const enrichmentsJson = JSON.stringify(enrichmentsForPage)

        const html = buildPublicPageHtml(
          feedsJson,
          entriesByFeedJson,
          allEntriesJson,
          enrichmentsJson,
        )
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=30",
        })
        res.end(html)
      })

      // ─── /api/public/sync-enrichment — Browser pushes AI enrichment data to server cache ───
      server.middlewares.use("/api/public/sync-enrichment", async (req, res) => {
        if (handleCors(req, res)) return
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }
        try {
          const body = await new Promise<string>((resolve) => {
            let data = ""
            req.on("data", (chunk: Buffer) => {
              data += chunk.toString()
            })
            req.on("end", () => resolve(data))
          })
          const incoming: EnrichmentMap = JSON.parse(body)
          const existing = readEnrichments()
          for (const [entryId, enrichment] of Object.entries(incoming)) {
            existing[entryId] = { ...existing[entryId], ...enrichment }
          }
          writeEnrichments(existing)
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(JSON.stringify({ ok: true, count: Object.keys(incoming).length }))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })

      // ─── /api/public/deploy — Build static HTML and deploy to Cloudflare Pages ───
      server.middlewares.use("/api/public/deploy", async (req, res) => {
        if (handleCors(req, res)) return
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }
        try {
          const body = await new Promise<string>((resolve) => {
            let data = ""
            req.on("data", (chunk: Buffer) => {
              data += chunk.toString()
            })
            req.on("end", () => resolve(data))
          })
          const { cfApiToken, cfAccountId } = JSON.parse(body || "{}")
          if (!cfApiToken || !cfAccountId) {
            res.writeHead(400, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ error: "cfApiToken and cfAccountId required" }))
            return
          }

          // Build HTML from cache
          const manifest = readManifest()
          const feeds = Object.values(manifest.feeds).sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
          )
          const entriesByFeed: Record<string, CachedEntry[]> = {}
          for (const feed of feeds) {
            const entriesFile = join(cacheDir, "entries", `${feed.id}.json`)
            if (existsSync(entriesFile)) {
              try {
                entriesByFeed[feed.id] = JSON.parse(readFileSync(entriesFile, "utf-8"))
              } catch {
                /* skip */
              }
            }
          }
          const allEntries = Object.values(entriesByFeed)
            .flat()
            .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
            .slice(0, 500)

          const enrichments = readEnrichments()
          // Strip embeddings from enrichments to reduce page size
          const enrichmentsForPage: Record<string, any> = {}
          for (const [id, en] of Object.entries(enrichments)) {
            const { embedding, ...rest } = en as any
            enrichmentsForPage[id] = rest
            if (embedding) enrichmentsForPage[id].embedding = embedding
          }
          const html = buildPublicPageHtml(
            JSON.stringify(feeds),
            JSON.stringify(entriesByFeed),
            JSON.stringify(allEntries),
            JSON.stringify(enrichmentsForPage),
          )

          // Deploy to Cloudflare Pages via wrangler CLI
          const { execSync } = await import("node:child_process")
          const tmpDir = join(cacheDir, "_pages_deploy")
          if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
          writeFileSync(join(tmpDir, "index.html"), html, "utf-8")

          const wranglerResult = execSync(
            `npx wrangler pages deploy "${tmpDir}" --project-name finhot --branch main --commit-dirty=true`,
            {
              env: {
                ...process.env,
                CLOUDFLARE_API_TOKEN: cfApiToken,
                CLOUDFLARE_ACCOUNT_ID: cfAccountId,
              },
              timeout: 120_000,
              encoding: "utf-8",
            },
          )
          const urlMatch = wranglerResult.match(/https:\/\/[a-z0-9]+\.finhot\.pages\.dev/)
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(
            JSON.stringify({ ok: true, url: urlMatch?.[0] ?? "https://finhot.industry7view.com" }),
          )
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })
    },
  }
}

// ─── Self-contained public reader HTML (pixel-perfect match to local React app) ───
function buildPublicPageHtml(
  feedsJson: string,
  entriesByFeedJson: string,
  allEntriesJson: string,
  enrichmentsJson: string,
): string {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FinHot — 金融动态聚合</title>
<meta name="description" content="金融资讯与市场观点聚合，实时追踪推特、雪球等信源">
<link rel="icon" href="/focal-logo.png" type="image/png">
<style>
/* ── Exact UIKit color tokens from tailwindcss-uikit-colors/src/macos/selector.css ── */
html, [data-theme="light"] {
  --color-red: 255 69 58; --color-orange: 255 149 0; --color-yellow: 255 204 0;
  --color-green: 40 205 65; --color-blue: 0 122 255; --color-gray: 142 142 147;
  --color-purple: 175 82 222;
  --color-fill: 0 0 0 / 0.1; --color-fillSecondary: 0 0 0 / 0.08;
  --color-fillTertiary: 0 0 0 / 0.05; --color-fillQuaternary: 0 0 0 / 0.03;
  --color-text: 0 0 0 / 0.85; --color-textSecondary: 0 0 0 / 0.5;
  --color-textTertiary: 0 0 0 / 0.25;
  --fo-a: 21.6 100% 50%;
  --background: 0 0% 100%; --color-background: 255 255 255;
  --border: 20 5.9% 90%;
  --fo-sidebar: 240 4.8% 95.9%;
  color-scheme: light;
}
[data-theme="dark"] {
  --color-red: 255 69 58; --color-orange: 255 159 10; --color-yellow: 255 214 10;
  --color-green: 50 215 75; --color-blue: 10 132 255; --color-gray: 152 152 157;
  --color-purple: 191 90 242;
  --color-fill: 255 255 255 / 0.1; --color-fillSecondary: 255 255 255 / 0.08;
  --color-fillTertiary: 255 255 255 / 0.05; --color-fillQuaternary: 255 255 255 / 0.03;
  --color-text: 255 255 255 / 0.85; --color-textSecondary: 255 255 255 / 0.5;
  --color-textTertiary: 255 255 255 / 0.25;
  --fo-a: 21.6 100% 50%;
  --background: 0 0% 7.1%; --color-background: 18 18 18;
  --border: 0 0% 22.1%;
  --fo-sidebar: 220 8.1% 14.5%;
  color-scheme: dark;
}
@media(prefers-color-scheme:dark){
  html:not([data-theme="light"]) {
    --color-red: 255 69 58; --color-orange: 255 159 10; --color-yellow: 255 214 10;
    --color-green: 50 215 75; --color-blue: 10 132 255; --color-gray: 152 152 157;
    --color-purple: 191 90 242;
    --color-fill: 255 255 255 / 0.1; --color-fillSecondary: 255 255 255 / 0.08;
    --color-fillTertiary: 255 255 255 / 0.05; --color-fillQuaternary: 255 255 255 / 0.03;
    --color-text: 255 255 255 / 0.85; --color-textSecondary: 255 255 255 / 0.5;
    --color-textTertiary: 255 255 255 / 0.25;
    --fo-a: 21.6 100% 50%;
    --background: 0 0% 7.1%; --color-background: 18 18 18;
    --border: 0 0% 22.1%;
    --fo-sidebar: 220 8.1% 14.5%;
    color-scheme: dark;
  }
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:hsl(var(--background));
  color:color-mix(in srgb, rgba(var(--color-text)) 100%, transparent);
  line-height:1.6;-webkit-font-smoothing:antialiased;
}
a{color:inherit;text-decoration:none}

/* ── Layout: sidebar + main (matches MainDesktopLayout) ── */
.app{display:flex;height:100vh;overflow:hidden}

/* ── Sidebar (matches SubscriptionColumnContainer) ── */
.sidebar{width:256px;flex-shrink:0;background:hsl(var(--fo-sidebar));border-right:1px solid hsl(var(--border));display:flex;flex-direction:column;overflow:hidden}
.logo{padding:20px 16px 12px;display:flex;align-items:center;gap:8px}
.logo-text{font-size:16px;font-weight:800;letter-spacing:-0.02em;color:hsl(var(--fo-a))}
.logo-dot{width:5px;height:5px;border-radius:50%;background:hsl(var(--fo-a));display:inline-block;margin:0 1px}
.logo-sub{font-size:10px;color:color-mix(in srgb, rgba(var(--color-textTertiary)) 100%, transparent);margin-top:1px;font-weight:400}
.nav{padding:4px 8px}
.nav-section{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:color-mix(in srgb, rgba(var(--color-textTertiary)) 100%, transparent);padding:12px 10px 4px}
.nav-item{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;font-size:13px;color:color-mix(in srgb, rgba(var(--color-textSecondary)) 100%, transparent);cursor:pointer;border:none;background:none;width:100%;text-align:left;transition:all 0.15s;font-family:inherit}
.nav-item:hover{background:color-mix(in srgb, rgba(var(--color-fillSecondary)) 100%, transparent);color:color-mix(in srgb, rgba(var(--color-text)) 100%, transparent)}
.nav-item.active{background:hsl(var(--fo-a) / 0.12);color:hsl(var(--fo-a));font-weight:600}
.nav-item svg{width:16px;height:16px;flex-shrink:0;opacity:0.5}
.nav-item.active svg{opacity:1}
.nav-item .feed-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.feed-list{flex:1;overflow-y:auto;padding:0 8px 8px;scrollbar-width:thin;scrollbar-color:color-mix(in srgb, rgba(var(--color-text)) 10%, transparent) transparent}
.feed-list::-webkit-scrollbar{width:4px}
.feed-list::-webkit-scrollbar-thumb{background:color-mix(in srgb, rgba(var(--color-text)) 10%, transparent);border-radius:4px}
.cat-header{display:flex;align-items:center;gap:6px;padding:8px 10px 4px;cursor:pointer;user-select:none;border:none;background:none;width:100%;text-align:left;font-family:inherit}
.cat-header .cat-arrow{width:12px;height:12px;flex-shrink:0;transition:transform 0.15s;color:color-mix(in srgb, rgba(var(--color-textTertiary)) 100%, transparent)}
.cat-header .cat-arrow.collapsed{transform:rotate(-90deg)}
.cat-header .cat-label{font-size:11px;font-weight:600;color:color-mix(in srgb, rgba(var(--color-textSecondary)) 100%, transparent)}
.cat-header .cat-count{font-size:10px;color:color-mix(in srgb, rgba(var(--color-textTertiary)) 100%, transparent);margin-left:auto}
.cat-feeds{overflow:hidden;transition:max-height 0.2s ease}
.cat-feeds.collapsed{max-height:0 !important;overflow:hidden}
.sidebar-footer{padding:10px 16px;border-top:1px solid hsl(var(--border));font-size:10px;color:color-mix(in srgb, rgba(var(--color-textTertiary)) 100%, transparent)}
.theme-row{display:flex;gap:4px;margin-top:6px}
.theme-btn{width:26px;height:26px;border:1px solid hsl(var(--border));border-radius:6px;background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:color-mix(in srgb, rgba(var(--color-textTertiary)) 100%, transparent);transition:all 0.15s}
.theme-btn:hover,.theme-btn.active{border-color:hsl(var(--fo-a) / 0.4);color:hsl(var(--fo-a));background:hsl(var(--fo-a) / 0.08)}

/* ── Main content area (matches <main> in MainDesktopLayout) ── */
.main{flex:1;display:flex;flex-direction:column;min-width:0;background:hsl(var(--background))}
.header{padding:16px 16px 0;flex-shrink:0}
.header-title{font-size:14px;font-weight:600;letter-spacing:-0.01em}
.header-sub{font-size:11px;color:color-mix(in srgb, rgba(var(--color-textSecondary)) 100%, transparent);margin-top:2px}

/* ── Platform filter tabs (matches PlatformFilterTabs.tsx) ── */
/* flex items-center gap-1 px-4 pb-2 pt-1 */
.tabs{display:flex;align-items:center;gap:4px;padding:4px 16px 8px;flex-shrink:0}
/* rounded-lg px-3 py-1.5 text-xs font-medium */
.tab{padding:6px 12px;border-radius:8px;font-size:12px;font-weight:500;
  color:color-mix(in srgb, rgba(var(--color-textSecondary)) 100%, transparent);
  cursor:pointer;border:1px solid transparent;background:none;transition:all 0.15s;font-family:inherit}
/* hover:bg-fill-secondary hover:text-text */
.tab:hover{background:color-mix(in srgb, rgba(var(--color-fillSecondary)) 100%, transparent);color:color-mix(in srgb, rgba(var(--color-text)) 100%, transparent)}
/* active: border border-accent/30 bg-accent/15 text-accent */
.tab.active{border-color:hsl(var(--fo-a) / 0.3);background:hsl(var(--fo-a) / 0.15);color:hsl(var(--fo-a));font-weight:600}

/* ── Entry card scroll area ── */
.entry-list{flex:1;overflow-y:auto;padding:0 0 32px;scrollbar-width:thin;scrollbar-color:color-mix(in srgb, rgba(var(--color-text)) 8%, transparent) transparent}
.entry-list::-webkit-scrollbar{width:6px}
.entry-list::-webkit-scrollbar-thumb{background:color-mix(in srgb, rgba(var(--color-text)) 8%, transparent);border-radius:6px}

/* ── Entry card (exact match to list-item-template.tsx) ── */
/* mx-2 my-1.5 rounded-xl border border-border/60 bg-fill-quaternary/50 px-4 py-3 */
.card{
  position:relative;
  margin:6px 8px;
  padding:12px 16px;
  border:1px solid hsl(var(--border) / 0.6);
  border-radius:12px;
  background:color-mix(in srgb, rgba(var(--color-fillQuaternary)) 50%, transparent);
  transition:all 0.15s;
}
.card:hover{border-color:hsl(var(--border));background:color-mix(in srgb, rgba(var(--color-fillQuaternary)) 100%, transparent)}
/* Unread indicator: border-l-2 border-l-accent */
.card.unread{border-left:2px solid hsl(var(--fo-a))}

/* ── Card header (flex items-center gap-2) ── */
.card-header{display:flex;align-items:center;gap:8px}
/* Feed icon 18px */
.card-feed-icon{width:18px;height:18px;border-radius:4px;flex-shrink:0;display:flex;align-items:center;justify-content:center;
  background:color-mix(in srgb, rgba(var(--color-fillSecondary)) 100%, transparent);
  color:color-mix(in srgb, rgba(var(--color-textTertiary)) 100%, transparent);
  font-size:10px;font-weight:700;overflow:hidden}
.card-feed-icon img{width:100%;height:100%;object-fit:cover}
/* Feed name: text-[11px] font-semibold text-text-secondary */
.card-feed-name{flex:1;min-width:0;font-size:11px;font-weight:600;
  color:color-mix(in srgb, rgba(var(--color-textSecondary)) 100%, transparent);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Time: text-[11px] text-text-tertiary */
.card-time{flex-shrink:0;font-size:11px;color:color-mix(in srgb, rgba(var(--color-textTertiary)) 100%, transparent)}

/* ── Quality score badge (exact match to EntryQualityScoreBadge.tsx) ── */
/* inline-flex min-w-[2rem] shrink-0 items-center justify-center rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums */
.q-score{display:inline-flex;align-items:center;justify-content:center;min-width:2rem;
  padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;flex-shrink:0}
/* bg-green/20 text-green border border-green/30 */
.q-high{background:rgb(var(--color-green) / 0.2);color:rgb(var(--color-green));border:1px solid rgb(var(--color-green) / 0.3)}
/* bg-yellow/15 text-yellow border border-yellow/20 */
.q-medium{background:rgb(var(--color-yellow) / 0.15);color:rgb(var(--color-yellow));border:1px solid rgb(var(--color-yellow) / 0.2)}
/* bg-gray/15 text-text-secondary border border-gray/15 */
.q-low{background:rgb(var(--color-gray) / 0.15);color:color-mix(in srgb, rgba(var(--color-textSecondary)) 100%, transparent);border:1px solid rgb(var(--color-gray) / 0.15)}
/* bg-gray/10 text-text-tertiary border border-gray/10 */
.q-ignore{background:rgb(var(--color-gray) / 0.1);color:color-mix(in srgb, rgba(var(--color-textTertiary)) 100%, transparent);border:1px solid rgb(var(--color-gray) / 0.1)}

/* ── Title (mt-1.5 text-[14px] font-semibold leading-snug text-text) ── */
.card-title{display:block;margin-top:6px;font-size:14px;font-weight:600;line-height:1.375;
  color:color-mix(in srgb, rgba(var(--color-text)) 100%, transparent);
  word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card-title:hover{color:hsl(var(--fo-a))}

/* ── Description / AI Summary (mt-1 text-[12px] leading-relaxed text-text-secondary) ── */
.card-desc{margin-top:4px;font-size:12px;line-height:1.625;
  color:color-mix(in srgb, rgba(var(--color-textSecondary)) 100%, transparent);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}

/* ── Footer: tags + cluster (mt-1.5 flex items-center gap-2) ── */
.card-footer{display:flex;align-items:center;gap:8px;margin-top:6px}
.card-tags{display:flex;flex-wrap:wrap;gap:4px;flex:1;min-width:0;margin:2px 0}
/* Tag chips (rounded bg-fill-secondary px-1.5 py-0.5 text-[10px] text-text-secondary) */
.tag{font-size:10px;padding:2px 6px;border-radius:4px;
  background:color-mix(in srgb, rgba(var(--color-fillSecondary)) 100%, transparent);
  color:color-mix(in srgb, rgba(var(--color-textSecondary)) 100%, transparent)}

/* ── Cluster badge (matches EntryClusterBadge.tsx) ── */
/* inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums */
/* bg-blue/10 text-blue → expanded: bg-accent/15 text-accent */
.cluster-badge{display:inline-flex;align-items:center;gap:2px;padding:2px 6px;border-radius:4px;
  font-size:11px;font-weight:500;cursor:pointer;transition:all 0.15s;font-variant-numeric:tabular-nums;
  background:rgb(var(--color-blue) / 0.1);color:rgb(var(--color-blue));flex-shrink:0;border:none;font-family:inherit}
.cluster-badge:hover{background:hsl(var(--fo-a) / 0.2)}
.cluster-badge.expanded{background:hsl(var(--fo-a) / 0.15);color:hsl(var(--fo-a))}
.cluster-member .card{margin-left:28px;border-left:2px solid rgb(var(--color-blue) / 0.3);opacity:0.88}

/* ── Empty state ── */
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:300px;
  color:color-mix(in srgb, rgba(var(--color-textTertiary)) 100%, transparent);font-size:13px;gap:8px}
.empty svg{width:40px;height:40px;opacity:0.3}

/* ── Mobile ── */
.mobile-toggle{display:none;position:fixed;top:12px;left:12px;z-index:60;width:36px;height:36px;border:none;border-radius:8px;
  background:hsl(var(--background));box-shadow:0 1px 4px rgba(0,0,0,0.1);cursor:pointer;
  color:color-mix(in srgb, rgba(var(--color-text)) 100%, transparent);align-items:center;justify-content:center}
.overlay{display:none;position:fixed;inset:0;z-index:40;background:rgba(0,0,0,0.3)}
@media(max-width:768px){
  .sidebar{position:fixed;left:0;top:0;bottom:0;z-index:50;transform:translateX(-100%);transition:transform 0.25s ease}
  .sidebar.open{transform:translateX(0)}
  .overlay.open{display:block}
  .mobile-toggle{display:flex}
  .header{padding:12px 12px 0}
  .tabs{padding:4px 12px 6px}
  .entry-list{padding:0 0 24px}
  .card{margin:4px;padding:10px 12px}
}
</style>
</head>
<body>
<div class="app">
<button class="mobile-toggle" id="mob-toggle" aria-label="菜单">
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
</button>
<aside class="sidebar" id="sidebar">
<div class="logo">
<div>
<div style="display:flex;align-items:center;gap:2px"><span class="logo-text">FIN</span><span class="logo-dot"></span><span class="logo-text">HOT</span></div>
<div class="logo-sub">金融动态聚合</div>
</div>
</div>
<nav class="nav">
<div class="nav-section">内容</div>
<button class="nav-item active" data-id="__all__">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
<span class="feed-name">全部动态</span>
</button>
</nav>
<div class="nav">
<div class="nav-section">信源</div>
</div>
<div class="feed-list" id="feed-list"></div>
<div class="sidebar-footer">
<div>Powered by FinHot</div>
<div class="theme-row">
<button class="theme-btn" data-theme="light" title="浅色"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg></button>
<button class="theme-btn" data-theme="system" title="跟随系统"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></button>
<button class="theme-btn" data-theme="dark" title="深色"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></button>
</div>
</div>
</aside>
<div class="overlay" id="overlay"></div>
<main class="main">
<div class="header">
<div class="header-title" id="header-title">全部动态</div>
<div class="header-sub" id="header-sub"></div>
</div>
<div class="tabs" id="tabs"></div>
<div class="entry-list" id="entry-list"></div>
</main>
</div>
<script>
(function(){
var feeds=${feedsJson};
var entriesByFeed=${entriesByFeedJson};
var allEntries=${allEntriesJson};
var enrichments=${enrichmentsJson};
var selectedFeedId=null;
var feedMap={};
feeds.forEach(function(f){feedMap[f.id]=f});

function esc(s){if(!s)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function strip(s){var t=document.createElement("div");t.innerHTML=s;return t.textContent||""}
function normalizeSummary(s){if(!s)return"";return s.replace(/\`\`\`[\\s\\S]*?\`\`\`/g," ").replace(/\`([^\`]+)\`/g,"$1").replace(/\\*\\*([^*]+)\\*\\*/g,"$1").replace(/\\*([^*]+)\\*/g,"$1").replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g,"$1").replace(/^\\s{0,3}#{1,6}\\s+/gm,"").replace(/^\\s*[-*+]\\s+/gm,"").replace(/\\s+/g," ").trim()}
function timeAgo(d){var diff=Date.now()-new Date(d).getTime();var m=Math.floor(diff/60000);if(m<1)return"刚刚";if(m<60)return m+"分钟前";var h=Math.floor(m/60);if(h<24)return h+"小时前";var days=Math.floor(h/24);if(days<30)return days+"天前";return new Date(d).toLocaleDateString("zh-CN")}
function scoreTier(s){return s>=70?"high":s>=40?"medium":s>=20?"low":"ignore"}
function feedInitial(title){if(!title)return"?";var c=title.charAt(0);return /[\\u4e00-\\u9fff]/.test(c)?c:c.toUpperCase()}

// ── Platform filter tabs (matches PLATFORM_LABELS) ──
var platformTabs=[{key:"all",label:"全部"},{key:"xueqiu",label:"雪球"},{key:"weibo",label:"微博"},{key:"twitter",label:"推特"},{key:"wechat",label:"公众号"},{key:"other",label:"其他"}];
var tabsEl=document.getElementById("tabs");
platformTabs.forEach(function(t){
  var btn=document.createElement("button");
  btn.className="tab"+(t.key==="all"?" active":"");
  btn.textContent=t.label;
  btn.setAttribute("data-cat",t.key);
  tabsEl.appendChild(btn);
});
var activeCat="all";

function getPlatform(feedUrl,cat){
  if(!feedUrl&&!cat)return"other";
  if(feedUrl){
    if(/xueqiu/i.test(feedUrl)||/localhost:8090/i.test(feedUrl))return"xueqiu";
    if(/twitter|nitter|xcancel|\\/x\\.com\\//i.test(feedUrl))return"twitter";
    if(/weibo/i.test(feedUrl))return"weibo";
    if(/wechat|mp\\.weixin/i.test(feedUrl))return"wechat";
  }
  if(cat==="雪球")return"xueqiu";if(cat==="推特")return"twitter";if(cat==="微博")return"weibo";if(cat==="公众号")return"wechat";
  return"other";
}

// ── Sidebar feed list (grouped by category) ──
var collapsedCats={};
var CAT_ORDER=["\u5fae\u535a","\u63a8\u7279","\u96ea\u7403","\u516c\u4f17\u53f7","\u5176\u4ed6"];
var CAT_ICONS={"\u5fae\u535a":'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',"\u63a8\u7279":'<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',"\u96ea\u7403":'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',"\u516c\u4f17\u53f7":'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',"\u5176\u4ed6":'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>'};
function groupFeeds(){
  var groups={};var order=[];
  feeds.forEach(function(f){
    var cat=f.category||"\u5176\u4ed6";
    if(!groups[cat]){groups[cat]=[];order.push(cat)}
    groups[cat].push(f);
  });
  order.sort(function(a,b){var ia=CAT_ORDER.indexOf(a);var ib=CAT_ORDER.indexOf(b);if(ia===-1)ia=99;if(ib===-1)ib=99;return ia-ib});
  return{groups:groups,order:order};
}
function renderFeeds(){
  var g=groupFeeds();
  var html="";
  var arrowSvg='<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
  g.order.forEach(function(cat){
    var list=g.groups[cat];
    var isCollapsed=!!collapsedCats[cat];
    var catIcon=CAT_ICONS[cat]||CAT_ICONS["\u5176\u4ed6"];
    html+='<button class="cat-header" data-cat-toggle="'+esc(cat)+'">';
    html+='<span class="cat-arrow'+(isCollapsed?' collapsed':'')+'">'+arrowSvg+'</span>';
    html+=catIcon;
    html+='<span class="cat-label">'+esc(cat)+'</span>';
    html+='<span class="cat-count">'+list.length+'</span>';
    html+='</button>';
    html+='<div class="cat-feeds'+(isCollapsed?' collapsed':'')+'" data-cat-group="'+esc(cat)+'">';
    list.forEach(function(f){
      var platform=getPlatform(f.url,f.category);
      var icon=(platform==="twitter")?'<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>':'<span>'+esc(feedInitial(f.title))+'</span>';
      html+='<button class="nav-item'+(selectedFeedId===f.id?" active":"")+'" data-id="'+esc(f.id)+'"><div class="card-feed-icon">'+icon+'</div><span class="feed-name">'+esc(f.title||f.url)+'</span></button>';
    });
    html+='</div>';
  });
  document.getElementById("feed-list").innerHTML=html;
  var allBtn=document.querySelector('.nav-item[data-id="__all__"]');
  if(allBtn)allBtn.className="nav-item"+(selectedFeedId===null?" active":"");
}

// ── Cosine similarity & clustering ──
function cosSim(a,b){if(!a||!b||a.length!==b.length)return 0;var dot=0,na=0,nb=0;for(var i=0;i<a.length;i++){dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i]}return na&&nb?dot/Math.sqrt(na*nb):0}
var expandedClusters={};
function buildClusters(entryList){
  var SIM=0.82,TIME_MS=86400000;
  var items=entryList.map(function(e){var en=enrichments[e.id];return en&&en.embedding?{id:e.id,vec:en.embedding,time:new Date(e.publishedAt).getTime(),feedId:e.feedId}:null}).filter(Boolean);
  var leaders={},memberOf={};
  for(var i=0;i<items.length;i++){
    if(memberOf[items[i].id])continue;
    var cluster=[items[i].id];
    for(var j=i+1;j<items.length;j++){
      if(memberOf[items[j].id])continue;
      if(Math.abs(items[i].time-items[j].time)>TIME_MS)continue;
      if(items[i].feedId===items[j].feedId)continue;
      if(cosSim(items[i].vec,items[j].vec)>=SIM){cluster.push(items[j].id);memberOf[items[j].id]=items[i].id}
    }
    if(cluster.length>1)leaders[items[i].id]=cluster;
  }
  return{leaders:leaders,memberOf:memberOf};
}

// ── Render a single entry card (exact match to list-item-template.tsx) ──
function renderCard(e,cl){
  var en=enrichments[e.id]||{};
  var feedTitle=feedMap[e.feedId]?feedMap[e.feedId].title:"";
  var feedUrl=feedMap[e.feedId]?feedMap[e.feedId].url:"";
  var feedCat=feedMap[e.feedId]?feedMap[e.feedId].category:"";
  var summary=en.summary?normalizeSummary(en.summary):"";
  var rawDesc=strip(e.description||e.content||"").slice(0,280);
  var displayDescription=summary||rawDesc;

  var h='<div class="card unread">';

  // Header row: feed icon + feed name + quality score + time
  h+='<div class="card-header">';
  h+='<div class="card-feed-icon"><span>'+esc(feedInitial(feedTitle))+'</span></div>';
  h+='<span class="card-feed-name">'+esc(feedTitle)+'</span>';
  if(en.qualityScore!=null){h+='<span class="q-score q-'+scoreTier(en.qualityScore)+'">'+en.qualityScore+'</span>'}
  h+='<span class="card-time">'+timeAgo(e.publishedAt)+'</span>';
  h+='</div>';

  // Title: mt-1.5 text-[14px] font-semibold leading-snug text-text
  if(e.title){
    h+='<a class="card-title" href="'+(e.url||"#")+'" target="_blank" rel="noopener">'+esc(e.title)+'</a>';
  }

  // Description / Summary: mt-1 text-[12px] leading-relaxed text-text-secondary line-clamp-2
  if(displayDescription&&e.title){
    h+='<div class="card-desc">'+esc(displayDescription)+'</div>';
  }

  // Footer: tags + cluster badge (mt-1.5 flex items-center gap-2)
  var tagsHtml="";
  if(en.tags&&en.tags.length){en.tags.forEach(function(t){tagsHtml+='<span class="tag">'+esc(typeof t==="object"?t.label||t:t)+'</span>'})}

  var clusterHtml="";
  if(cl&&cl.leaders[e.id]){
    var count=cl.leaders[e.id].length-1;
    var isExp=!!expandedClusters[e.id];
    clusterHtml='<button class="cluster-badge'+(isExp?" expanded":"")+'" data-cluster="'+esc(e.id)+'">+'+count+' 相关</button>';
  }

  if(tagsHtml||clusterHtml){
    h+='<div class="card-footer"><div class="card-tags">'+tagsHtml+'</div>'+clusterHtml+'</div>';
  }
  h+='</div>';
  return h;
}

// ── Render entry list ──
function renderTimeline(){
  var entries=selectedFeedId?((entriesByFeed[selectedFeedId]||[]).slice(0,200)):allEntries;
  if(activeCat!=="all"){
    entries=entries.filter(function(e){
      var f=feedMap[e.feedId];if(!f)return false;
      return getPlatform(f.url,f.category)===activeCat;
    });
  }
  document.getElementById("header-title").textContent=selectedFeedId?(feedMap[selectedFeedId]?feedMap[selectedFeedId].title:"动态"):"全部动态";
  document.getElementById("header-sub").textContent=entries.length+" 条内容"+(selectedFeedId?"":(" · "+feeds.length+" 个信源"));
  if(!entries.length){document.getElementById("entry-list").innerHTML='<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg><div>暂无内容</div></div>';return}

  var cl=buildClusters(entries);
  var html="";
  entries.forEach(function(e){
    if(cl.memberOf[e.id]&&!expandedClusters[cl.memberOf[e.id]])return;
    var isClusterMember=!!cl.memberOf[e.id];
    html+=(isClusterMember?'<div class="cluster-member">':'')+renderCard(e,cl)+(isClusterMember?'</div>':'');
  });
  document.getElementById("entry-list").innerHTML=html;
  document.getElementById("entry-list").scrollTop=0;
}

// ── Events ──
document.addEventListener("click",function(ev){
  var catToggle=ev.target.closest(".cat-header");
  if(catToggle){
    var cat=catToggle.getAttribute("data-cat-toggle");
    collapsedCats[cat]=!collapsedCats[cat];
    var arrow=catToggle.querySelector(".cat-arrow");
    var group=document.querySelector('.cat-feeds[data-cat-group="'+cat+'"]');
    if(arrow)arrow.classList.toggle("collapsed");
    if(group)group.classList.toggle("collapsed");
    return;
  }
  var navItem=ev.target.closest(".nav-item");
  if(navItem){
    var id=navItem.getAttribute("data-id");
    selectedFeedId=id==="__all__"?null:id;
    renderFeeds();renderTimeline();
    if(window.innerWidth<=768){document.getElementById("sidebar").classList.remove("open");document.getElementById("overlay").classList.remove("open")}
    return;
  }
  var clBtn=ev.target.closest(".cluster-badge");
  if(clBtn){var cid=clBtn.getAttribute("data-cluster");expandedClusters[cid]=!expandedClusters[cid];renderTimeline();return}
  var tab=ev.target.closest(".tab");
  if(tab){
    activeCat=tab.getAttribute("data-cat");
    document.querySelectorAll(".tab").forEach(function(t){t.className="tab"+(t.getAttribute("data-cat")===activeCat?" active":"")});
    renderTimeline();return;
  }
});
document.getElementById("mob-toggle").addEventListener("click",function(){document.getElementById("sidebar").classList.toggle("open");document.getElementById("overlay").classList.toggle("open")});
document.getElementById("overlay").addEventListener("click",function(){document.getElementById("sidebar").classList.remove("open");document.getElementById("overlay").classList.remove("open")});

// ── Theme (data-theme attribute, matches local app) ──
var themeKey="finhot-theme";
function applyTheme(t){
  if(t==="dark"){document.documentElement.setAttribute("data-theme","dark")}
  else if(t==="light"){document.documentElement.setAttribute("data-theme","light")}
  else{document.documentElement.removeAttribute("data-theme")}
  document.querySelectorAll(".theme-btn").forEach(function(b){b.classList.toggle("active",b.getAttribute("data-theme")===t)});
  try{localStorage.setItem(themeKey,t)}catch(e){}
}
document.querySelectorAll(".theme-btn").forEach(function(b){b.addEventListener("click",function(){applyTheme(b.getAttribute("data-theme"))})});
try{var saved=localStorage.getItem(themeKey);if(saved)applyTheme(saved);else{applyTheme(window.matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light")}}catch(e){}

renderFeeds();renderTimeline();
})();
</script>
</body>
</html>`
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
