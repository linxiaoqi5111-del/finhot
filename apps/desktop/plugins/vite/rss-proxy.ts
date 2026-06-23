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
  /** Why this entry was selected — distinct from content summary */
  recommendationReason?: string | null
  tags?: string[]
  qualityScore?: number | null
  qualityTier?: string | null
  /** Selection status: "selected" (≥70), "watch" (40-69), "noise" (<40) */
  selected?: "selected" | "watch" | "noise" | null
  qualityDetails?: {
    contentTypes?: Record<string, number>
    scores?: Record<string, number>
    positiveReasons?: string[]
    negativeReasons?: string[]
    confidence?: number
    summary?: string
  }
  translation?: {
    title?: string | null
    description?: string | null
    content?: string | null
    readabilityContent?: string | null
  }
  /** Cluster ID (leader entry id) for multi-source event grouping */
  clusterId?: string | null
  /** Related entry IDs in the same event cluster */
  relatedEntryIds?: string[]
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

/** Derive selection status from quality score */
function deriveSelected(en: CachedEnrichment): "selected" | "watch" | "noise" | null {
  if (en.selected) return en.selected
  if (en.qualityScore == null) return null
  if (en.qualityScore >= 70) return "selected"
  if (en.qualityScore >= 40) return "watch"
  return "noise"
}

/** Selection label for display */
function selectionLabel(sel: string | null, score: number | null): string {
  if (!sel || score == null) return ""
  if (sel === "selected") return `精选 ${score}`
  if (sel === "watch") return `观察 ${score}`
  return ""
}

/** Load all cached entries sorted by time */
function loadAllCachedEntries(): CachedEntry[] {
  const manifest = readManifest()
  const allEntries: CachedEntry[] = []
  for (const feedKey of Object.keys(manifest.feeds)) {
    const entriesFile = join(cacheDir, "entries", `${feedKey}.json`)
    if (!existsSync(entriesFile)) continue
    try {
      const feedEntries: CachedEntry[] = JSON.parse(readFileSync(entriesFile, "utf-8"))
      allEntries.push(...feedEntries)
    } catch { /* skip */ }
  }
  allEntries.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
  return allEntries
}

/** Build RSS 2.0 XML from entries */
function buildRssXml(
  title: string,
  description: string,
  link: string,
  entries: CachedEntry[],
  enrichments: EnrichmentMap,
  feedMap: Record<string, CachedFeed>,
): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

  let items = ""
  for (const e of entries.slice(0, 100)) {
    const en = enrichments[e.id]
    const feedTitle = feedMap[e.feedId]?.title ?? ""
    const summary = en?.summary ?? ""
    const reason = en?.recommendationReason ?? ""
    const sel = deriveSelected(en ?? {})
    const scoreLabel = selectionLabel(sel, en?.qualityScore ?? null)

    let desc = ""
    if (scoreLabel) desc += `【${scoreLabel}】`
    if (reason) desc += `${reason} `
    if (summary) desc += summary
    if (!desc) desc = e.description ?? ""
    desc = desc.slice(0, 500)

    items += `<item>
<title>${esc(e.title ?? "")}</title>
<link>${esc(e.url ?? "")}</link>
<guid isPermaLink="false">${esc(e.id)}</guid>
<pubDate>${new Date(e.publishedAt).toUTCString()}</pubDate>
<description>${esc(desc)}</description>
<author>${esc(e.author ?? feedTitle)}</author>
${en?.tags?.length ? en.tags.map((t) => `<category>${esc(t)}</category>`).join("") : ""}
</item>\n`
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${esc(title)}</title>
<link>${esc(link)}</link>
<description>${esc(description)}</description>
<language>zh-CN</language>
<generator>FinHot</generator>
<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>`
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

        const html = buildPublicPageHtmlLocalStyle(
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

      // ─── /api/public/items — Enhanced items with enrichment data ───
      server.middlewares.use("/api/public/items", async (req, res) => {
        if (handleCors(req, res)) return
        if (req.method !== "GET") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }
        try {
          const parsedUrl = new URL(req.url ?? "/", "http://localhost")
          const filter = parsedUrl.searchParams.get("filter") ?? "selected"
          const since = parsedUrl.searchParams.get("since")
          const q = parsedUrl.searchParams.get("q")
          const category = parsedUrl.searchParams.get("category")
          const limitParam = parsedUrl.searchParams.get("limit")
          const limit = limitParam ? Math.min(Number.parseInt(limitParam, 10), 500) : 50

          let entries = loadAllCachedEntries()
          const enrichments = readEnrichments()
          const manifest = readManifest()

          if (since) {
            const sinceMs = new Date(since).getTime()
            entries = entries.filter((e) => new Date(e.publishedAt).getTime() >= sinceMs)
          }

          if (q) {
            const lq = q.toLowerCase()
            entries = entries.filter(
              (e) =>
                (e.title ?? "").toLowerCase().includes(lq) ||
                (enrichments[e.id]?.summary ?? "").toLowerCase().includes(lq) ||
                (enrichments[e.id]?.tags ?? []).some((t) => t.toLowerCase().includes(lq)),
            )
          }

          if (category) {
            entries = entries.filter((e) => {
              const feed = manifest.feeds[e.feedId]
              return feed?.category === category
            })
          }

          if (filter === "selected") {
            entries = entries.filter((e) => deriveSelected(enrichments[e.id] ?? {}) === "selected")
          } else if (filter === "watch") {
            entries = entries.filter((e) => {
              const sel = deriveSelected(enrichments[e.id] ?? {})
              return sel === "selected" || sel === "watch"
            })
          }

          const items = entries.slice(0, limit).map((e) => {
            const en = enrichments[e.id] ?? {}
            const feed = manifest.feeds[e.feedId]
            return {
              id: e.id,
              title: e.title,
              url: e.url,
              publishedAt: e.publishedAt,
              author: e.author,
              feedId: e.feedId,
              feedTitle: feed?.title ?? null,
              feedCategory: feed?.category ?? null,
              summary: en.summary ?? null,
              recommendationReason: en.recommendationReason ?? null,
              qualityScore: en.qualityScore ?? null,
              selected: deriveSelected(en),
              tags: en.tags ?? [],
              translation: en.translation ?? null,
              clusterId: en.clusterId ?? null,
              relatedEntryIds: en.relatedEntryIds ?? [],
            }
          })

          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=60",
          })
          res.end(JSON.stringify({ items, total: items.length, filter }))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })

      // ─── /api/public/topics — Event clusters / hot topics ───
      server.middlewares.use("/api/public/topics", async (req, res) => {
        if (handleCors(req, res)) return
        if (req.method !== "GET") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }
        try {
          const allEntries = loadAllCachedEntries()
          const enrichments = readEnrichments()
          const manifest = readManifest()

          // Build clusters using embedding similarity
          const SIM_THRESHOLD = 0.82
          const TIME_WINDOW_MS = 86400000
          const items = allEntries
            .map((e) => {
              const en = enrichments[e.id]
              return en?.embedding
                ? {
                    id: e.id,
                    vec: en.embedding,
                    time: new Date(e.publishedAt).getTime(),
                    feedId: e.feedId,
                  }
                : null
            })
            .filter(
              (x): x is { id: string; vec: number[]; time: number; feedId: string } => x !== null,
            )

          function cosSim(a: number[], b: number[]): number {
            if (a.length !== b.length) return 0
            let dot = 0,
              na = 0,
              nb = 0
            for (let i = 0; i < a.length; i++) {
              dot += a[i]! * b[i]!
              na += a[i]! * a[i]!
              nb += b[i]! * b[i]!
            }
            return na && nb ? dot / Math.sqrt(na * nb) : 0
          }

          const memberOf: Record<string, string> = {}
          const clusters: { leaderId: string; members: string[] }[] = []

          for (let i = 0; i < items.length; i++) {
            const item = items[i]!
            if (memberOf[item.id]) continue
            const cluster = [item.id]
            for (let j = i + 1; j < items.length; j++) {
              const other = items[j]!
              if (memberOf[other.id]) continue
              if (Math.abs(item.time - other.time) > TIME_WINDOW_MS) continue
              if (item.feedId === other.feedId) continue
              if (cosSim(item.vec, other.vec) >= SIM_THRESHOLD) {
                cluster.push(other.id)
                memberOf[other.id] = item.id
              }
            }
            if (cluster.length > 1) {
              clusters.push({ leaderId: item.id, members: cluster })
            }
          }

          // Sort by cluster size (most sources first), then by recency
          clusters.sort((a, b) => b.members.length - a.members.length)

          const entryMap: Record<string, CachedEntry> = {}
          for (const e of allEntries) entryMap[e.id] = e

          const topics = clusters.slice(0, 20).map((c) => {
            const leader = entryMap[c.leaderId]
            const en = enrichments[c.leaderId] ?? {}
            const sources = new Set(
              c.members.map((mid) => manifest.feeds[entryMap[mid]?.feedId ?? ""]?.title).filter(Boolean),
            )
            return {
              id: c.leaderId,
              title: leader?.title ?? null,
              sourceCount: sources.size,
              sources: [...sources],
              entryCount: c.members.length,
              entries: c.members,
              publishedAt: leader?.publishedAt ?? null,
              summary: en.summary ?? null,
              qualityScore: en.qualityScore ?? null,
              selected: deriveSelected(en),
              tags: en.tags ?? [],
            }
          })

          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=120",
          })
          res.end(JSON.stringify({ topics, total: topics.length }))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })

      // ─── /api/public/daily — Today's digest (selected + watch, grouped) ───
      server.middlewares.use("/api/public/daily", async (req, res) => {
        if (handleCors(req, res)) return
        if (req.method !== "GET") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }
        try {
          const parsedUrl = new URL(req.url ?? "/", "http://localhost")
          const dateParam = parsedUrl.searchParams.get("date")

          const targetDate = dateParam ? new Date(dateParam) : new Date()
          targetDate.setHours(0, 0, 0, 0)
          const dayStart = targetDate.getTime()
          const dayEnd = dayStart + 86400000

          const allEntries = loadAllCachedEntries()
          const enrichments = readEnrichments()
          const manifest = readManifest()

          const todayEntries = allEntries.filter((e) => {
            const t = new Date(e.publishedAt).getTime()
            return t >= dayStart && t < dayEnd
          })

          const selected = todayEntries.filter(
            (e) => deriveSelected(enrichments[e.id] ?? {}) === "selected",
          )
          const watch = todayEntries.filter(
            (e) => deriveSelected(enrichments[e.id] ?? {}) === "watch",
          )

          const mapEntry = (e: CachedEntry) => {
            const en = enrichments[e.id] ?? {}
            const feed = manifest.feeds[e.feedId]
            return {
              id: e.id,
              title: e.title,
              url: e.url,
              publishedAt: e.publishedAt,
              feedTitle: feed?.title ?? null,
              summary: en.summary ?? null,
              recommendationReason: en.recommendationReason ?? null,
              qualityScore: en.qualityScore ?? null,
              selected: deriveSelected(en),
              tags: en.tags ?? [],
            }
          }

          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=120",
          })
          res.end(
            JSON.stringify({
              date: targetDate.toISOString().slice(0, 10),
              totalEntries: todayEntries.length,
              selected: selected.map(mapEntry),
              watch: watch.map(mapEntry),
            }),
          )
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })

      // ─── /feed.xml — Selected entries RSS (精选, qualityScore ≥ 70) ───
      server.middlewares.use("/feed.xml", async (_req, res) => {
        try {
          const allEntries = loadAllCachedEntries()
          const enrichments = readEnrichments()
          const manifest = readManifest()
          const feedMap = manifest.feeds

          const selected = allEntries.filter((e) => {
            const en = enrichments[e.id]
            if (!en) return false
            const sel = deriveSelected(en)
            return sel === "selected"
          })

          const xml = buildRssXml(
            "FinHot 精选",
            "AI 精选金融资讯 — 质量分 ≥ 70",
            "/feed.xml",
            selected.slice(0, 100),
            enrichments,
            feedMap,
          )
          res.writeHead(200, {
            "Content-Type": "application/rss+xml; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=120",
          })
          res.end(xml)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(500, { "Content-Type": "text/plain" })
          res.end(message)
        }
      })

      // ─── /feed/all.xml — All entries RSS ───
      server.middlewares.use("/feed/all.xml", async (_req, res) => {
        try {
          const allEntries = loadAllCachedEntries()
          const enrichments = readEnrichments()
          const manifest = readManifest()
          const feedMap = manifest.feeds

          const xml = buildRssXml(
            "FinHot 全部动态",
            "所有订阅源的最新内容",
            "/feed/all.xml",
            allEntries.slice(0, 200),
            enrichments,
            feedMap,
          )
          res.writeHead(200, {
            "Content-Type": "application/rss+xml; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=120",
          })
          res.end(xml)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(500, { "Content-Type": "text/plain" })
          res.end(message)
        }
      })

      // ─── /feed/daily.xml — Daily digest RSS (today's selected entries) ───
      server.middlewares.use("/feed/daily.xml", async (_req, res) => {
        try {
          const allEntries = loadAllCachedEntries()
          const enrichments = readEnrichments()
          const manifest = readManifest()
          const feedMap = manifest.feeds

          const todayStart = new Date()
          todayStart.setHours(0, 0, 0, 0)
          const todayMs = todayStart.getTime()

          const todaySelected = allEntries.filter((e) => {
            if (new Date(e.publishedAt).getTime() < todayMs) return false
            const en = enrichments[e.id]
            if (!en) return false
            const sel = deriveSelected(en)
            return sel === "selected" || sel === "watch"
          })

          const xml = buildRssXml(
            "FinHot 日报",
            `${todayStart.toISOString().slice(0, 10)} 精选日报`,
            "/feed/daily.xml",
            todaySelected.slice(0, 50),
            enrichments,
            feedMap,
          )
          res.writeHead(200, {
            "Content-Type": "application/rss+xml; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=300",
          })
          res.end(xml)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(500, { "Content-Type": "text/plain" })
          res.end(message)
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
          const html = buildPublicPageHtmlLocalStyle(
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

function buildPublicPageHtmlLocalStyle(
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
<title>FinHot</title>
<meta name="description" content="金融资讯与市场观点聚合">
<link rel="icon" href="/focal-logo.png" type="image/png">
<style>
html,[data-theme="light"]{
  --color-red:255 69 58;--color-orange:255 149 0;--color-yellow:255 204 0;--color-green:40 205 65;--color-blue:0 122 255;--color-gray:142 142 147;
  --color-fill:0 0 0 / .1;--color-fillSecondary:0 0 0 / .08;--color-fillTertiary:0 0 0 / .05;--color-fillQuaternary:0 0 0 / .03;
  --color-text:0 0 0 / .86;--color-textSecondary:0 0 0 / .56;--color-textTertiary:0 0 0 / .34;--fo-a:21.6 100% 50%;
  --background:0 0% 100%;--border:20 5.9% 90%;--fo-sidebar:240 4.8% 95.9%;color-scheme:light;
}
[data-theme="dark"]{
  --color-red:255 69 58;--color-orange:255 159 10;--color-yellow:255 214 10;--color-green:50 215 75;--color-blue:10 132 255;--color-gray:152 152 157;
  --color-fill:255 255 255 / .1;--color-fillSecondary:255 255 255 / .08;--color-fillTertiary:255 255 255 / .05;--color-fillQuaternary:255 255 255 / .03;
  --color-text:255 255 255 / .86;--color-textSecondary:255 255 255 / .56;--color-textTertiary:255 255 255 / .34;--fo-a:21.6 100% 50%;
  --background:0 0% 7.1%;--border:0 0% 22.1%;--fo-sidebar:220 8.1% 14.5%;color-scheme:dark;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:hsl(var(--background));color:rgba(var(--color-text));line-height:1.45;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}.app{display:flex;height:100vh;overflow:hidden;background:hsl(var(--background))}
.sidebar{width:256px;flex:0 0 256px;margin:8px;height:calc(100vh - 16px);border-radius:16px;background:rgb(247,247,247);box-shadow:0 12px 32px -26px rgba(0,0,0,.42);display:flex;flex-direction:column;overflow:hidden}
[data-theme="dark"] .sidebar{background:hsl(var(--fo-sidebar));box-shadow:0 18px 40px -24px rgba(0,0,0,.85)}
.brand{height:32px;display:flex;align-items:center;justify-content:space-between;margin:0 12px 0 16px;gap:8px}.brand-main{display:flex;align-items:center;gap:6px;min-width:0}.brand-mark{width:24px;height:24px;border-radius:7px;background:hsl(var(--fo-a));color:white;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800}.brand-title{font-size:18px;font-weight:760;color:hsl(var(--fo-a));letter-spacing:0}.brand-sub{display:none}
.brand-tools{display:flex;align-items:center;gap:6px;color:rgba(var(--color-textSecondary))}.brand-tool{width:24px;height:24px;border:0;border-radius:7px;background:transparent;color:inherit;display:flex;align-items:center;justify-content:center;cursor:pointer}.brand-tool:hover{background:rgba(var(--color-fillSecondary));color:rgba(var(--color-text))}
.side-scroll{flex:1;overflow:auto;margin-top:12px;padding:0 4px 10px;scrollbar-width:thin}.nav-section{height:24px;display:flex;align-items:center;border-radius:6px;padding:0 10px;font-size:12px;font-weight:650;color:rgba(var(--color-textSecondary))}
.nav-item,.group-head{width:100%;height:32px;border:0;background:transparent;border-radius:6px;color:rgba(var(--color-textSecondary));font:inherit;font-size:14px;font-weight:520;line-height:1.75;display:flex;align-items:center;gap:8px;padding:0 10px;cursor:pointer;text-align:left}
.nav-item:hover,.group-head:hover{background:rgba(var(--color-fillSecondary));color:rgba(var(--color-text))}.nav-item.active{background:hsl(var(--fo-a) / .14);color:hsl(var(--fo-a));font-weight:650}
.nav-ico{width:16px;height:16px;display:flex;align-items:center;justify-content:center;flex:0 0 16px;opacity:.9}.nav-ico svg{width:16px;height:16px}.feed-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.count{margin-left:auto;font-size:12px;color:rgba(var(--color-textTertiary));font-variant-numeric:tabular-nums}.active .count{color:hsl(var(--fo-a) / .8)}
.group{margin-top:1px}.group-head{height:24px;font-size:12px;font-weight:650;color:rgba(var(--color-textSecondary));padding-left:10px}.chev{width:12px;transition:transform .15s;color:rgba(var(--color-textTertiary))}.group.collapsed .chev{transform:rotate(-90deg)}.group.collapsed .group-body{display:none}.feed-dot{width:16px;height:16px;border-radius:5px;background:rgba(var(--color-fillSecondary));display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:rgba(var(--color-textTertiary));flex:0 0 16px}
.sidebar-footer{padding:8px 12px 8px;color:rgba(var(--color-textTertiary));font-size:12px}.theme-row{display:flex;gap:4px}.theme-btn{width:24px;height:24px;border:0;border-radius:7px;background:transparent;color:rgba(var(--color-textTertiary));cursor:pointer}.theme-btn.active,.theme-btn:hover{color:hsl(var(--fo-a));background:hsl(var(--fo-a) / .08)}
.main{flex:1;min-width:0;display:flex;flex-direction:column;background:hsl(var(--background))}.topbar{height:52px;display:flex;align-items:center;justify-content:space-between;padding:8px 16px 0 8px;border-bottom:1px solid transparent}
.title-wrap{min-width:0}.header-title{font-size:15px;font-weight:680;letter-spacing:0}.header-sub{margin-top:1px;font-size:11px;color:rgba(var(--color-textTertiary));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tools{display:flex;align-items:center;gap:6px}.tool-btn{width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:rgba(var(--color-textTertiary));display:flex;align-items:center;justify-content:center;cursor:pointer}.tool-btn:hover{background:rgba(var(--color-fillSecondary));color:rgba(var(--color-text))}
.tabs{display:flex;align-items:center;gap:4px;padding:7px 16px;border-bottom:1px solid rgba(var(--color-fillTertiary));overflow:auto;flex:0 0 auto}.tab{height:28px;padding:0 11px;border-radius:8px;border:1px solid transparent;background:transparent;color:rgba(var(--color-textSecondary));font:inherit;font-size:12px;font-weight:520;cursor:pointer;white-space:nowrap}.tab:hover{background:rgba(var(--color-fillSecondary));color:rgba(var(--color-text))}.tab.active{border-color:hsl(var(--fo-a) / .3);background:hsl(var(--fo-a) / .14);color:hsl(var(--fo-a));font-weight:650}
.entry-list{flex:1;overflow:auto;padding:6px 8px 28px;scrollbar-width:thin}.card{position:relative;margin:6px 0;padding:11px 14px 11px 16px;border:1px solid hsl(var(--border) / .58);border-left:2px solid hsl(var(--fo-a));border-radius:10px;background:rgba(var(--color-fillQuaternary));transition:background .15s,border-color .15s,box-shadow .15s}.card:hover{background:rgba(var(--color-fillTertiary));border-color:hsl(var(--border));box-shadow:0 3px 14px rgba(0,0,0,.035)}
.card-head{display:flex;align-items:center;gap:7px}.feed-icon{width:18px;height:18px;border-radius:5px;background:rgba(var(--color-fillSecondary));display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:750;color:rgba(var(--color-textTertiary));overflow:hidden}.feed-icon img{width:100%;height:100%;object-fit:cover}.source{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(var(--color-textSecondary));font-size:11px;font-weight:650}.time{font-size:11px;color:rgba(var(--color-textTertiary));white-space:nowrap}.q{min-width:28px;border-radius:4px;padding:1px 5px;text-align:center;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums}.q-high{background:rgb(var(--color-green) / .18);color:rgb(var(--color-green));border:1px solid rgb(var(--color-green) / .26)}.q-medium{background:rgb(var(--color-yellow) / .15);color:rgb(var(--color-yellow));border:1px solid rgb(var(--color-yellow) / .22)}.q-low{background:rgb(var(--color-gray) / .14);color:rgba(var(--color-textSecondary));border:1px solid rgb(var(--color-gray) / .14)}.q-wrap{position:relative;display:inline-flex;flex:0 0 auto}.q-wrap:focus{outline:none}.q-wrap:hover .q-detail,.q-wrap:focus-within .q-detail{display:block}.q-detail{display:none;position:absolute;right:0;top:calc(100% + 8px);z-index:30;width:320px;max-width:min(320px,calc(100vw - 24px));padding:10px;border:1px solid hsl(var(--border));border-radius:12px;background:hsl(var(--background));box-shadow:0 10px 28px rgba(0,0,0,.12);color:rgba(var(--color-text));font-size:11px;font-weight:400;line-height:1.45}.q-detail-title{font-size:12px;font-weight:720;margin-bottom:4px}.q-detail-muted{color:rgba(var(--color-textTertiary))}.q-grid{display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;margin-top:6px}.q-types{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}.q-reasons{margin-top:6px;padding-left:14px}
.card.open{border-color:hsl(var(--fo-a) / .36);background:hsl(var(--fo-a) / .035)}.card-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:6px;font-size:14px;font-weight:680;line-height:1.36;color:rgba(var(--color-text));word-break:break-word}.card-title:hover{color:hsl(var(--fo-a))}button.card-title{width:100%;border:0;background:transparent;text-align:left;font:inherit;cursor:pointer}.desc{margin-top:4px;font-size:12px;line-height:1.58;color:rgba(var(--color-textSecondary));display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}.card-foot{display:flex;align-items:center;gap:6px;margin-top:7px}.tags{display:flex;flex-wrap:wrap;gap:4px;min-width:0;flex:1}.tag{border-radius:4px;background:rgba(var(--color-fillSecondary));color:rgba(var(--color-textSecondary));font-size:10px;padding:2px 6px}.cluster{border:0;border-radius:4px;background:rgb(var(--color-blue) / .1);color:rgb(var(--color-blue));font:inherit;font-size:11px;padding:2px 6px;cursor:pointer}.cluster.on{background:hsl(var(--fo-a) / .15);color:hsl(var(--fo-a))}.member{margin-left:24px;opacity:.9}.ai-panel{margin-top:10px;border-radius:12px;border:1px solid hsl(var(--fo-a) / .18);background:linear-gradient(135deg,hsl(var(--fo-a) / .07),transparent 52%),rgba(var(--color-fillQuaternary));box-shadow:0 8px 24px rgba(0,0,0,.045);overflow:hidden}.ai-card{padding:12px}.ai-head{display:flex;align-items:center;justify-content:space-between;gap:8px;color:hsl(var(--fo-a));font-size:12px;font-weight:720}.ai-title{display:flex;align-items:center;gap:6px}.ai-dot{width:8px;height:8px;border-radius:999px;background:hsl(var(--fo-a));box-shadow:0 0 0 4px hsl(var(--fo-a) / .12)}.ai-body{margin-top:9px;color:rgba(var(--color-text));font-size:13px;line-height:1.62;white-space:pre-wrap;word-break:break-word}.ai-section{border-top:1px solid hsl(var(--border) / .62);padding:12px}.ai-section-title{font-size:12px;font-weight:720;color:rgba(var(--color-textSecondary));margin-bottom:7px}.ai-link{display:inline-flex;align-items:center;gap:5px;margin-top:10px;color:hsl(var(--fo-a));font-size:12px;font-weight:650}.translation-title{font-size:13px;font-weight:680;color:rgba(var(--color-text));margin-bottom:6px}
.radar-wrap{display:flex;flex-direction:column;gap:8px;padding:4px 4px 26px}.radar-card{overflow:hidden;border:1px solid hsl(var(--fo-a) / .16);border-radius:12px;background:linear-gradient(135deg,hsl(var(--fo-a) / .035),transparent 46%),rgba(var(--color-fillQuaternary));box-shadow:0 4px 16px hsl(var(--fo-a) / .04),0 2px 8px rgba(0,0,0,.045)}.radar-main{width:100%;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:flex-start;gap:10px;padding:12px}.radar-main:hover{background:rgba(var(--color-fillQuaternary))}.radar-title-row{display:flex;align-items:flex-start;gap:8px}.radar-title{flex:1;min-width:0;font-size:14px;font-weight:680;line-height:1.35}.heat{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:hsl(var(--fo-a));white-space:nowrap}.heat-dot{width:7px;height:7px;border-radius:999px;background:hsl(var(--fo-a));box-shadow:0 0 0 3px hsl(var(--fo-a) / .12)}.chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}.chip{border-radius:6px;background:rgba(var(--color-fillTertiary));color:rgba(var(--color-textSecondary));font-size:11px;padding:2px 6px}.meta{display:flex;gap:12px;margin-top:7px;color:rgba(var(--color-textTertiary));font-size:11px}.radar-chevron{width:16px;color:rgba(var(--color-textTertiary));transition:transform .15s}.radar-card.open .radar-chevron{transform:rotate(180deg)}.radar-entries{display:none;border-top:1px solid hsl(var(--fo-a) / .13);padding:7px 10px 10px}.radar-card.open .radar-entries{display:block}.radar-entry{display:flex;align-items:center;gap:8px;border-radius:8px;padding:6px 6px;color:rgba(var(--color-textSecondary));font-size:12px}.radar-entry:hover{background:rgba(var(--color-fillQuaternary));color:rgba(var(--color-text))}.radar-entry-title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty{height:300px;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;color:rgba(var(--color-textTertiary));font-size:13px}.empty svg{width:38px;height:38px;opacity:.38}
.mobile-toggle{display:none;position:fixed;left:12px;top:10px;z-index:60;width:34px;height:34px;border:0;border-radius:8px;background:hsl(var(--background));color:rgba(var(--color-text));box-shadow:0 1px 7px rgba(0,0,0,.12)}
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.32);z-index:40}
@media(max-width:520px){.sidebar{position:fixed;inset:0 auto 0 0;z-index:50;height:100vh;margin:0;border-radius:0;transform:translateX(-100%);transition:transform .22s}.sidebar.open{transform:translateX(0)}.overlay.open{display:block}.mobile-toggle{display:flex;align-items:center;justify-content:center}.topbar{padding-left:56px}.tabs{padding-left:12px}.entry-list{padding:5px 4px 24px}.card{border-radius:9px;padding:10px 12px}.member{margin-left:12px}}
</style>
</head>
<body>
<div class="app">
<button class="mobile-toggle" id="mobile-toggle" aria-label="菜单"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button>
<aside class="sidebar" id="sidebar">
  <div class="brand">
    <div class="brand-main"><div class="brand-mark">F</div><div class="brand-title">FinHot</div><div class="brand-sub">金融动态聚合</div></div>
    <div class="brand-tools">
      <button class="brand-tool" title="刷新"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M18 2v4h4"/><path d="M6 22v-4H2"/></svg></button>
      <button class="brand-tool" title="添加"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></button>
    </div>
  </div>
  <div class="side-scroll">
    <div class="nav-section">智能</div>
    <div id="smart-nav"></div>
    <div class="nav-section">信源</div>
    <div id="source-groups"></div>
  </div>
  <div class="sidebar-footer"><span>Public View</span><div class="theme-row"><button class="theme-btn" data-theme="light" title="浅色">L</button><button class="theme-btn" data-theme="system" title="系统">S</button><button class="theme-btn" data-theme="dark" title="深色">D</button></div></div>
</aside>
<div class="overlay" id="overlay"></div>
<main class="main">
  <div class="topbar">
    <div class="title-wrap"><div class="header-title" id="header-title">今天</div><div class="header-sub" id="header-sub"></div></div>
    <div class="tools">
      <button class="tool-btn" title="最新"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M7 12h10M10 18h4"/></svg></button>
      <button class="tool-btn" title="视图"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16M4 12h16M4 19h16"/></svg></button>
    </div>
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
var feedMap={};feeds.forEach(function(f){feedMap[f.id]=f});
var selectedFeedId=null;
var activeView="smart-today";
var activeCat="all";
var expandedGroups={};
var expandedClusters={};
var expandedTopicId=null;
var activeEntryId=null;

function esc(s){if(s==null)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function strip(s){if(!s)return"";var d=document.createElement("div");d.innerHTML=s;return d.textContent||""}
function plain(s){return String(s||"").split(String.fromCharCode(96)).join("").replace(/\\*\\*([^*]+)\\*\\*/g,"$1").replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g,"$1").replace(/^\\s{0,3}#{1,6}\\s+/gm,"").replace(/^\\s*[-*+]\\s+/gm,"").replace(/\\s+/g," ").trim()}
function when(d){var t=new Date(d).getTime();var diff=Date.now()-t;var m=Math.floor(diff/60000);if(!isFinite(t))return"";if(m<1)return"刚刚";if(m<60)return m+"分钟前";var h=Math.floor(m/60);if(h<24)return h+"小时前";var days=Math.floor(h/24);if(days<30)return days+"天前";return new Date(t).toLocaleDateString("zh-CN")}
function shortTime(t){var d=new Date(t);var hh=String(d.getHours()).padStart(2,"0");var mm=String(d.getMinutes()).padStart(2,"0");var n=new Date();if(d.toDateString()===n.toDateString())return hh+":"+mm;return (d.getMonth()+1)+"/"+d.getDate()+" "+hh+":"+mm}
function initial(s){s=String(s||"?");var c=s.charAt(0);return /[\\u4e00-\\u9fff]/.test(c)?c:c.toUpperCase()}
function scoreVal(en){if(!en)return null;var v=en.qualityScore;if(v==null)v=en.quality_score;v=Number(v);return isFinite(v)?Math.round(v):null}
function scoreTier(v){return v>=70?"high":v>=40?"medium":"low"}
function qualityDetailHtml(en){
  var d=en&&(en.qualityDetails||en.quality_details);if(!d)return"";
  var scores=d.scores||{};
  var scoreKeys=[["information_gain","信息增量"],["depth","深度"],["evidence","证据"],["actionability","可操作"],["originality","原创"],["signal_density","密度"]];
  var scoreRows=scoreKeys.map(function(k){var v=scores[k[0]];return v==null?"":'<span>'+esc(k[1])+' '+esc(v)+'/5</span>'}).join("");
  var types=d.contentTypes||d.content_types||{};
  var typeRows=Object.keys(types).filter(function(k){return Number(types[k])>0}).sort(function(a,b){return Number(types[b])-Number(types[a])}).slice(0,3).map(function(k){return '<span class="tag">'+esc(k)+' '+Math.round(Number(types[k])*100)+'%</span>'}).join("");
  var positives=(d.positiveReasons||d.positive_reasons||[]).slice(0,3).map(function(r){return '<li>'+esc(r)+'</li>'}).join("");
  var negatives=(d.negativeReasons||d.negative_reasons||[]).slice(0,2).map(function(r){return '<li>'+esc(r)+'</li>'}).join("");
  var confidence=d.confidence==null?null:Math.round(Number(d.confidence)*100);
  var html='<span class="q-detail" role="tooltip"><div class="q-detail-title">AI 打分明细</div>';
  if(confidence!=null&&isFinite(confidence))html+='<div class="q-detail-muted">置信度 '+confidence+'%</div>';
  if(d.summary)html+='<div style="margin-top:6px">'+esc(d.summary)+'</div>';
  if(typeRows)html+='<div class="q-types">'+typeRows+'</div>';
  if(scoreRows)html+='<div class="q-grid">'+scoreRows+'</div>';
  if(positives)html+='<ul class="q-reasons">'+positives+'</ul>';
  if(negatives)html+='<ul class="q-reasons q-detail-muted">'+negatives+'</ul>';
  return html+'</span>';
}
function textHtml(s){return esc(String(s||"").trim()).replace(/\\n{3,}/g,"\\n\\n")}
function translationText(en){
  var tr=en&&(en.translation||en.translated);if(!tr)return"";
  return tr.readabilityContent||tr.content||tr.description||"";
}
function hasTranslation(en){return !!translationText(en)||!!(en&&en.translation&&(en.translation.title||en.translation.description))}
function renderEntryInsight(e,en,f){
  var summary=String(en.summary||"").trim();
  var tr=en.translation||{};
  var translatedBody=translationText(en);
  var hasAny=summary||hasTranslation(en);
  var h='<div class="ai-panel">';
  h+='<div class="ai-card"><div class="ai-head"><span class="ai-title"><span class="ai-dot"></span>AI 总结</span>';
  var score=scoreVal(en);if(score!=null)h+='<span class="q q-'+scoreTier(score)+'">'+score+'</span>';
  h+='</div><div class="ai-body">'+(summary?textHtml(summary):'暂无 AI 总结')+'</div>';
  if(e.url)h+='<a class="ai-link" href="'+esc(e.url)+'" target="_blank" rel="noopener">打开原文 ↗</a>';
  h+='</div>';
  if(hasTranslation(en)){
    h+='<div class="ai-section"><div class="ai-section-title">翻译</div>';
    if(tr.title)h+='<div class="translation-title">'+textHtml(tr.title)+'</div>';
    if(translatedBody)h+='<div class="ai-body">'+textHtml(translatedBody)+'</div>';
    h+='</div>';
  }
  return h+'</div>';
}
function platform(feed){var u=(feed&&feed.url||"").toLowerCase();var c=(feed&&feed.category||"").toLowerCase();if(u.indexOf("xueqiu")>=0||u.indexOf("localhost:8090")>=0||c.indexOf("雪球")>=0)return"xueqiu";if(u.indexOf("twitter")>=0||u.indexOf("x.com")>=0||u.indexOf("nitter")>=0||u.indexOf("xcancel")>=0||c.indexOf("推特")>=0)return"twitter";if(u.indexOf("weibo")>=0||c.indexOf("微博")>=0)return"weibo";if(u.indexOf("wechat")>=0||u.indexOf("mp.weixin")>=0||c.indexOf("公众号")>=0)return"wechat";return"other"}
function platformLabel(p){return p==="xueqiu"?"雪球":p==="twitter"?"推特":p==="weibo"?"微博":p==="wechat"?"公众号":"RSS"}
function visibleByCat(e){if(activeCat==="all")return true;return platform(feedMap[e.feedId])===activeCat}
function isToday(e){var d=new Date(e.publishedAt);var n=new Date();return d.toDateString()===n.toDateString()}
function countForFeed(id){return (entriesByFeed[id]||[]).length}
function icon(name){var icons={today:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2v4M16 2v4M3 10h18"/><rect x="3" y="4" width="18" height="18" rx="2"/></svg>',unread:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h6"/></svg>',star:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.3L5.8 21 7 14.2 2 9.3l6.9-1z"/></svg>',radar:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20a8 8 0 1 0-8-8"/><path d="M12 16a4 4 0 1 0-4-4"/><path d="M12 12 4 20"/></svg>'};return icons[name]||""}

var radarTopics=buildRadarTopics();
if(!allEntries.some(isToday))activeView="smart-unread";

function renderSmartNav(){
  var todayCount=allEntries.filter(isToday).length;
  var items=[
    {id:"smart-today",label:"今天",count:todayCount,ico:"today"},
    {id:"smart-unread",label:"全部未读",count:allEntries.length,ico:"unread"},
    {id:"smart-favorites",label:"收藏",count:0,ico:"star"},
    {id:"smart-radar",label:"热点雷达",count:radarTopics.length,ico:"radar"}
  ];
  document.getElementById("smart-nav").innerHTML=items.map(function(it){
    return '<button class="nav-item '+(activeView===it.id?"active":"")+'" data-view="'+it.id+'"><span class="nav-ico">'+icon(it.ico)+'</span><span class="feed-name">'+it.label+'</span><span class="count">'+it.count+'</span></button>';
  }).join("");
}

function renderSourceGroups(){
  var groups={};
  feeds.forEach(function(f){var label=f.category||platformLabel(platform(f));if(!groups[label])groups[label]=[];groups[label].push(f)});
  var html="";
  Object.keys(groups).sort(function(a,b){return groups[b].length-groups[a].length}).forEach(function(label){
    if(expandedGroups[label]==null)expandedGroups[label]=true;
    var collapsed=!expandedGroups[label];
    var total=groups[label].reduce(function(n,f){return n+countForFeed(f.id)},0);
    html+='<div class="group '+(collapsed?"collapsed":"")+'" data-group="'+esc(label)+'">';
    html+='<button class="group-head" data-group-toggle="'+esc(label)+'"><span class="chev">⌄</span><span class="feed-name">'+esc(label)+'</span><span class="count">'+total+'</span></button><div class="group-body">';
    groups[label].sort(function(a,b){return countForFeed(b.id)-countForFeed(a.id)}).forEach(function(f){
      html+='<button class="nav-item '+(selectedFeedId===f.id?"active":"")+'" data-feed="'+esc(f.id)+'"><span class="feed-dot">'+esc(initial(f.title||f.url))+'</span><span class="feed-name">'+esc(f.title||f.url)+'</span><span class="count">'+countForFeed(f.id)+'</span></button>';
    });
    html+='</div></div>';
  });
  document.getElementById("source-groups").innerHTML=html;
}

function renderTabs(){
  var tabs=[["all","全部"],["xueqiu","雪球"],["weibo","微博"],["twitter","推特"],["wechat","公众号"],["other","RSS"]];
  document.getElementById("tabs").innerHTML=tabs.map(function(t){return '<button class="tab '+(activeCat===t[0]?"active":"")+'" data-cat="'+t[0]+'">'+t[1]+'</button>'}).join("");
}

function selectedEntries(){
  var list=[];
  if(selectedFeedId)list=(entriesByFeed[selectedFeedId]||[]).slice();
  else if(activeView==="smart-today")list=allEntries.filter(isToday);
  else if(activeView==="smart-favorites")list=[];
  else list=allEntries.slice();
  return list.filter(visibleByCat).sort(function(a,b){return new Date(b.publishedAt).getTime()-new Date(a.publishedAt).getTime()});
}

function render(){
  renderSmartNav();renderSourceGroups();renderTabs();
  if(activeView==="smart-radar"&&!selectedFeedId){renderRadar();return}
  renderTimeline();
}

function header(title,sub){document.getElementById("header-title").textContent=title;document.getElementById("header-sub").textContent=sub||""}
function empty(msg,sub){document.getElementById("entry-list").innerHTML='<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M9 12h6"/></svg><div>'+esc(msg)+'</div>'+(sub?'<div>'+esc(sub)+'</div>':"")+'</div>'}

function renderTimeline(){
  var entries=selectedEntries();
  var title=selectedFeedId?(feedMap[selectedFeedId]&&feedMap[selectedFeedId].title||"动态"):(activeView==="smart-today"?"今天":activeView==="smart-favorites"?"收藏":"全部未读");
  header(title,entries.length+" 未读"+(selectedFeedId?"":" · "+feeds.length+" 个信源"));
  if(!entries.length){empty("暂无内容",activeView==="smart-today"?"今天当前筛选下没有内容":"");return}
  var cl=buildClusters(entries);
  var html="";
  entries.slice(0,500).forEach(function(e){
    var parent=cl.memberOf[e.id];if(parent&&!expandedClusters[parent])return;
    html+=(parent?'<div class="member">':"")+renderCard(e,cl)+(parent?"</div>":"");
  });
  var list=document.getElementById("entry-list");list.innerHTML=html;list.scrollTop=0;
}

function renderCard(e,cl){
  var en=enrichments[e.id]||{};var f=feedMap[e.feedId]||{};var score=scoreVal(en);
  var isOpen=activeEntryId===e.id;
  var desc=plain(en.summary)||strip(e.description||e.content||"").replace(/\\s+/g," ").trim().slice(0,280);
  var tags=Array.isArray(en.tags)?en.tags.slice(0,4):[];
  var h='<article class="card '+(isOpen?"open":"")+'" data-entry-card="'+esc(e.id)+'"><div class="card-head"><span class="feed-icon">'+(f.image?'<img src="'+esc(f.image)+'" alt="">':esc(initial(f.title||f.url)))+'</span><span class="source">'+esc(f.title||f.url||"")+'</span>';
  if(score!=null)h+='<span class="q-wrap" tabindex="0"><span class="q q-'+scoreTier(score)+'">'+score+'</span>'+qualityDetailHtml(en)+'</span>';
  h+='<span class="time">'+when(e.publishedAt)+'</span></div>';
  h+='<button class="card-title" data-open-entry="'+esc(e.id)+'">'+esc(e.title||"(无标题)")+'</button>';
  if(desc)h+='<div class="desc">'+esc(desc)+'</div>';
  var foot="";
  if(tags.length)foot+='<div class="tags">'+tags.map(function(t){return '<span class="tag">'+esc(typeof t==="object"?(t.label||t.name||""):t)+'</span>'}).join("")+'</div>';
  if(cl.leaders[e.id])foot+='<button class="cluster '+(expandedClusters[e.id]?"on":"")+'" data-cluster="'+esc(e.id)+'">+'+(cl.leaders[e.id].length-1)+' 相关</button>';
  if(foot)h+='<div class="card-foot">'+foot+'</div>';
  if(isOpen)h+=renderEntryInsight(e,en,f);
  return h+'</article>';
}

function cos(a,b){if(!a||!b||a.length!==b.length)return 0;var dot=0,aa=0,bb=0;for(var i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i]}return aa&&bb?dot/Math.sqrt(aa*bb):0}
function buildClusters(entries){
  var leaders={},memberOf={},items=entries.map(function(e){var en=enrichments[e.id]||{};return en.embedding&&en.embedding.length?{id:e.id,vec:en.embedding,time:new Date(e.publishedAt).getTime(),feed:e.feedId}:null}).filter(Boolean);
  for(var i=0;i<items.length;i++){if(memberOf[items[i].id])continue;var ids=[items[i].id];for(var j=i+1;j<items.length;j++){if(memberOf[items[j].id])continue;if(items[i].feed===items[j].feed)continue;if(Math.abs(items[i].time-items[j].time)>18*3600000)continue;if(cos(items[i].vec,items[j].vec)>=.78){ids.push(items[j].id);memberOf[items[j].id]=items[i].id}}if(ids.length>1)leaders[items[i].id]=ids}
  return{leaders:leaders,memberOf:memberOf};
}

function heat(sourceCount,latestAt,size){var age=Date.now()-latestAt;var rec=age>86400000?0.25:age>43200000?0.5:age>3600000?0.75:1;return Math.pow(sourceCount,1.5)*rec*Math.log2(size+1)}
function buildRadarTopics(){
  var cutoff=Date.now()-3*86400000;
  var entries=allEntries.filter(function(e){return new Date(e.publishedAt).getTime()>=cutoff});
  var clusters=buildClusters(entries).leaders;
  var topics=Object.keys(clusters).map(function(id){return makeTopic(id,clusters[id])}).filter(Boolean);
  if(!topics.length){
    var buckets={};
    entries.forEach(function(e){var en=enrichments[e.id]||{};var tags=Array.isArray(en.tags)?en.tags:[];var key=tags.length?String(typeof tags[0]==="object"?(tags[0].label||tags[0].name):tags[0]):plain(e.title).slice(0,12);if(!key)return;if(!buckets[key])buckets[key]=[];buckets[key].push(e.id)});
    topics=Object.keys(buckets).map(function(k){return buckets[k].length>1?makeTopic("tag-"+k,buckets[k]):null}).filter(Boolean);
  }
  topics.sort(function(a,b){return b.heat-a.heat});
  return topics.slice(0,60);
}
function makeTopic(id,ids){
  var entries=ids.map(function(eid){return allEntries.find(function(e){return e.id===eid})}).filter(Boolean);
  if(entries.length<2)return null;
  var sourceIds=[];entries.forEach(function(e){if(sourceIds.indexOf(e.feedId)<0)sourceIds.push(e.feedId)});
  var times=entries.map(function(e){return new Date(e.publishedAt).getTime()}).filter(isFinite);
  var scores=entries.map(function(e){return scoreVal(enrichments[e.id])}).filter(function(v){return v!=null});
  var pick=entries.slice().sort(function(a,b){return (scoreVal(enrichments[b.id])||0)-(scoreVal(enrichments[a.id])||0)})[0]||entries[0];
  var earliest=Math.min.apply(Math,times);var latest=Math.max.apply(Math,times);
  return{id:id,title:pick.title||"(无标题)",entryIds:entries.map(function(e){return e.id}),sourceNames:sourceIds.map(function(fid){var f=feedMap[fid]||{};return f.title||f.url||fid}),sourceCount:sourceIds.length,size:entries.length,earliestAt:earliest,latestAt:latest,avgQualityScore:scores.length?Math.round(scores.reduce(function(a,b){return a+b},0)/scores.length):null,heat:heat(sourceIds.length,latest,entries.length)};
}

function renderRadar(){
  var topics=radarTopics;
  if(activeCat!=="all")topics=topics.filter(function(t){return t.entryIds.some(function(id){var e=allEntries.find(function(x){return x.id===id});return e&&visibleByCat(e)})});
  header("热点雷达",topics.length+" 个话题 · "+allEntries.length+" 条内容");
  if(!topics.length){empty("暂无热点话题","需要更多订阅内容和 AI 嵌入后才能聚合");return}
  document.getElementById("entry-list").innerHTML='<div class="radar-wrap">'+topics.map(renderTopic).join("")+'</div>';
}
function renderTopic(t){
  var open=expandedTopicId===t.id;
  var h='<section class="radar-card '+(open?"open":"")+'"><button class="radar-main" data-topic="'+esc(t.id)+'"><div style="min-width:0;flex:1"><div class="radar-title-row"><span class="radar-title">'+esc(t.title)+'</span><span class="heat"><span class="heat-dot"></span>'+t.sourceCount+'源</span></div>';
  h+='<div class="chips">'+t.sourceNames.slice(0,5).map(function(n){return '<span class="chip">'+esc(n.length>9?n.slice(0,9)+"...":n)+'</span>'}).join("")+(t.sourceNames.length>5?'<span class="chip">+'+(t.sourceNames.length-5)+'</span>':"")+'</div>';
  h+='<div class="meta"><span>'+shortTime(t.earliestAt)+' -> '+shortTime(t.latestAt)+'</span><span>'+t.size+'条</span>'+(t.avgQualityScore!=null?'<span>质量 '+t.avgQualityScore+'</span>':"")+'</div></div><svg class="radar-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg></button>';
  h+='<div class="radar-entries">'+t.entryIds.slice(0,8).map(function(id){var e=allEntries.find(function(x){return x.id===id});if(!e)return"";return '<a class="radar-entry" href="'+esc(e.url||"#")+'" target="_blank" rel="noopener"><span class="radar-entry-title">'+esc(e.title||"(无标题)")+'</span><span class="time">'+when(e.publishedAt)+'</span></a>'}).join("")+'</div></section>';
  return h;
}

document.addEventListener("click",function(ev){
  var view=ev.target.closest("[data-view]");if(view){activeView=view.getAttribute("data-view");selectedFeedId=null;activeEntryId=null;render();closeMobile();return}
  var feed=ev.target.closest("[data-feed]");if(feed){selectedFeedId=feed.getAttribute("data-feed");activeView="feed";activeEntryId=null;render();closeMobile();return}
  var group=ev.target.closest("[data-group-toggle]");if(group){var g=group.getAttribute("data-group-toggle");expandedGroups[g]=!expandedGroups[g];renderSourceGroups();return}
  var tab=ev.target.closest("[data-cat]");if(tab&&tab.classList.contains("tab")){activeCat=tab.getAttribute("data-cat");activeEntryId=null;render();return}
  var cluster=ev.target.closest("[data-cluster]");if(cluster){var cid=cluster.getAttribute("data-cluster");expandedClusters[cid]=!expandedClusters[cid];renderTimeline();return}
  var openEntry=ev.target.closest("[data-open-entry]");if(openEntry){var eid=openEntry.getAttribute("data-open-entry");activeEntryId=activeEntryId===eid?null:eid;renderTimeline();return}
  var card=ev.target.closest("[data-entry-card]");if(card&&!ev.target.closest("a,button,.q-wrap")){var ceid=card.getAttribute("data-entry-card");activeEntryId=activeEntryId===ceid?null:ceid;renderTimeline();return}
  var topic=ev.target.closest("[data-topic]");if(topic){var tid=topic.getAttribute("data-topic");expandedTopicId=expandedTopicId===tid?null:tid;renderRadar();return}
});
function closeMobile(){if(window.innerWidth<=520){document.getElementById("sidebar").classList.remove("open");document.getElementById("overlay").classList.remove("open")}}
document.getElementById("mobile-toggle").addEventListener("click",function(){document.getElementById("sidebar").classList.toggle("open");document.getElementById("overlay").classList.toggle("open")});
document.getElementById("overlay").addEventListener("click",closeMobile);

var themeKey="finhot-theme";
function applyTheme(t){if(t==="dark")document.documentElement.setAttribute("data-theme","dark");else if(t==="light")document.documentElement.setAttribute("data-theme","light");else document.documentElement.removeAttribute("data-theme");document.querySelectorAll(".theme-btn").forEach(function(b){b.classList.toggle("active",b.getAttribute("data-theme")===t)});try{localStorage.setItem(themeKey,t)}catch(e){}}
document.querySelectorAll(".theme-btn").forEach(function(b){b.addEventListener("click",function(){applyTheme(b.getAttribute("data-theme"))})});
try{applyTheme("light")}catch(e){applyTheme("light")}
render();
})();
</script>
</body>
</html>`
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
