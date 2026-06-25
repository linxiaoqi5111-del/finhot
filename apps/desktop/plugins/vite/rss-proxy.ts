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
const PUBLIC_SITE_BASE =
  process.env.FINHOT_PUBLIC_BASE_URL || process.env.VITE_PUBLIC_API_BASE || ""
const TOPIC_RECENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
const TOPIC_CLUSTER_TIME_WINDOW_MS = 18 * 60 * 60 * 1000
const TOPIC_SIMILARITY_THRESHOLD = 0.78

const DETAIL_ALLOWED_TAGS = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "div",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
])
const DETAIL_VOID_TAGS = new Set(["br", "hr", "img"])
const DETAIL_GLOBAL_ATTRS = new Set(["title"])
const DETAIL_TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
  img: new Set(["src", "alt", "title", "width", "height", "loading"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
}

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
let projectRoot = ""

function ensureCacheDir(rootDir: string) {
  if (cacheDir) return cacheDir
  projectRoot = rootDir
  cacheDir = join(rootDir, ".finhot-cache")
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
  const entriesDir = join(cacheDir, "entries")
  if (!existsSync(entriesDir)) mkdirSync(entriesDir, { recursive: true })
  return cacheDir
}

// ─── Weibo auto-import via RSSHub ───

const WEIBO_RSSHUB_FETCH_CONCURRENCY = 5
const WEIBO_RSSHUB_TIMEOUT_MS = 15_000
const WEIBO_IMPORT_INTERVAL_MS = 30 * 60 * 1000

interface WatchlistData {
  weibo?: string[]
  xueqiu?: string[]
  wechat?: string[]
  x?: string[]
  rss?: { name: string; url: string }[]
}

function loadWatchlistWeiboUids(): string[] {
  if (!projectRoot) return []
  const watchlistPath = join(projectRoot, "finhot", "watchlist.json")
  if (!existsSync(watchlistPath)) return []
  try {
    const data: WatchlistData = JSON.parse(readFileSync(watchlistPath, "utf-8"))
    return data.weibo ?? []
  } catch {
    return []
  }
}

async function fetchWeiboViaRSSHub(uid: string): Promise<{
  feed: ReturnType<typeof parseRssFeed>["feed"]
  entries: ReturnType<typeof parseRssFeed>["entries"]
} | null> {
  const rsshubUrl = `http://localhost:1200/weibo/user/${uid}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEIBO_RSSHUB_TIMEOUT_MS)
  try {
    const res = await fetch(rsshubUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "FinHot/0.1.4 (RSS Reader)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const xml = await res.text()
    if (!xml.includes("<rss") && !xml.includes("<feed") && !xml.includes("<?xml")) return null
    return parseRssFeed(xml, rsshubUrl, RSS_ENTRY_LIMIT)
  } catch {
    clearTimeout(timer)
    return null
  }
}

async function autoImportWeiboFeeds(): Promise<number> {
  console.info(`[FinHot] autoImportWeiboFeeds: projectRoot=${projectRoot}, cacheDir=${cacheDir}`)
  const uids = loadWatchlistWeiboUids()
  console.info(`[FinHot] Loaded ${uids.length} Weibo UIDs from watchlist.json`)
  if (uids.length === 0) return 0

  let imported = 0
  let failed = 0
  for (let i = 0; i < uids.length; i += WEIBO_RSSHUB_FETCH_CONCURRENCY) {
    const batch = uids.slice(i, i + WEIBO_RSSHUB_FETCH_CONCURRENCY)
    const results = await Promise.allSettled(batch.map((uid) => fetchWeiboViaRSSHub(uid)))
    for (const [j, result] of results.entries()) {
      const uid = batch[j]
      if (result.status === "fulfilled" && result.value) {
        cacheFeedResult(result.value.feed, result.value.entries, "微博")
        imported++
      } else {
        failed++
        if (failed <= 3) {
          const reason = result.status === "rejected" ? String(result.reason) : "null result"
          console.info(`[FinHot] Weibo fetch failed uid=${uid}: ${reason}`)
        }
      }
    }
  }
  console.info(`[FinHot] Weibo import done: imported=${imported}, failed=${failed}`)
  return imported
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

function escapeXml(value: string | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function publicUrl(path: string, base = PUBLIC_SITE_BASE): string {
  if (!base) return path
  try {
    return new URL(path, base).toString()
  } catch {
    return path
  }
}

function publicRequestBase(req: { headers?: Record<string, string | string[] | undefined> }) {
  if (PUBLIC_SITE_BASE) return PUBLIC_SITE_BASE
  const host = req.headers?.host
  const proto = req.headers?.["x-forwarded-proto"] ?? "http"
  const firstHost = Array.isArray(host) ? host[0] : host
  const firstProto = Array.isArray(proto) ? proto[0] : proto
  return firstHost ? `${firstProto}://${firstHost}` : ""
}

function stripUrlControlCharacters(value: string): string {
  let output = ""
  for (const char of value.trim()) {
    const code = char.codePointAt(0) ?? 0
    if (code > 0x20 && code !== 0x7f) output += char
  }
  return output
}

function isSafeDetailUrl(value: string, attr: string): boolean {
  const normalized = stripUrlControlCharacters(value)
  if (!normalized) return false
  if (normalized.startsWith("/") && !normalized.startsWith("//")) return true
  try {
    const url = new URL(normalized)
    if (url.protocol === "http:" || url.protocol === "https:") return true
    return attr === "href" && url.protocol === "mailto:"
  } catch {
    return false
  }
}

/* eslint-disable regexp/match-any, regexp/no-super-linear-backtracking, regexp/use-ignore-case -- The detail page sanitizer works on bounded RSS entry fragments and intentionally uses small tag-level regex passes before allowlist filtering. */
function sanitizeDetailHtml(value: string): string {
  const withoutDangerousBlocks = value
    .replaceAll(/<!--[\S\s]*?-->/g, "")
    .replaceAll(/<!doctype[\S\s]*?>/gi, "")
    .replaceAll(
      /<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|svg|math)[^>]*>[\S\s]*?<\s*\/\s*\1\s*>/gi,
      "",
    )
    .replaceAll(
      /<\s*\/?\s*(script|style|iframe|object|embed|form|input|button|textarea|select|svg|math)[^>]*>/gi,
      "",
    )

  return withoutDangerousBlocks.replaceAll(
    /<\/?([a-zA-Z][\w:-]*)([^>]*)>/g,
    (rawTag, rawName: string, rawAttrs: string) => {
      const tag = rawName.toLowerCase()
      if (!DETAIL_ALLOWED_TAGS.has(tag)) return ""
      if (rawTag.startsWith("</")) return DETAIL_VOID_TAGS.has(tag) ? "" : `</${tag}>`

      const allowedAttrs = new Set([
        ...DETAIL_GLOBAL_ATTRS,
        ...(DETAIL_TAG_ATTRS[tag] ? [...DETAIL_TAG_ATTRS[tag]] : []),
      ])
      const attrs: string[] = []
      const attrRegex = /\s+([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
      for (const match of rawAttrs.matchAll(attrRegex)) {
        const attrName = match[1]!.toLowerCase()
        if (attrName.startsWith("on") || !allowedAttrs.has(attrName)) continue
        const attrValue = match[2] ?? match[3] ?? match[4] ?? ""
        if ((attrName === "href" || attrName === "src") && !isSafeDetailUrl(attrValue, attrName)) {
          continue
        }
        if (
          (attrName === "width" ||
            attrName === "height" ||
            attrName === "colspan" ||
            attrName === "rowspan") &&
          !/^\d{1,4}$/.test(attrValue)
        ) {
          continue
        }
        attrs.push(`${attrName}="${escapeXml(attrValue)}"`)
      }

      if (tag === "a") {
        attrs.push('target="_blank"', 'rel="noopener noreferrer"')
      }
      if (tag === "img" && !attrs.some((attr) => attr.startsWith("loading="))) {
        attrs.push('loading="lazy"')
      }

      return `<${tag}${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}>`
    },
  )
}
/* eslint-enable regexp/match-any, regexp/no-super-linear-backtracking, regexp/use-ignore-case */

function stripHtmlToText(value: string | null | undefined): string {
  return String(value ?? "")
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/[`*_#>\-[\]()]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
}

function isSubstantiallyDuplicateText(
  first: string | null | undefined,
  second: string | null | undefined,
): boolean {
  const a = stripHtmlToText(first).toLowerCase()
  const b = stripHtmlToText(second).toLowerCase()
  if (!a || !b) return false
  if (a === b) return true
  if (Math.min(a.length, b.length) < 40) return false
  return a.includes(b) || b.includes(a)
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

const SCORE_GATE_THRESHOLD = 55

/** Detect feed platform from URL and category */
function detectPlatform(
  feedUrl: string | null | undefined,
  category: string | null | undefined,
): string {
  const u = (feedUrl ?? "").toLowerCase()
  const c = (category ?? "").toLowerCase()
  if (/:8090/.test(u) || /wechat|mp\.weixin/.test(u) || c.includes("公众号")) return "wechat"
  if (/xueqiu/.test(u) || c === "雪球") return "xueqiu"
  if (/twitter|nitter|xcancel|\/x\.com\//.test(u) || c === "推特") return "twitter"
  if (/weibo/.test(u) || c === "微博") return "weibo"
  return "other"
}

/** Check if entry passes the platform-aware score gate */
function passesScoreGateServer(
  entry: CachedEntry,
  enrichments: Record<string, CachedEnrichment>,
  manifest: FeedCacheManifest,
): boolean {
  const feed = manifest.feeds[entry.feedId]
  if (!feed) return false
  const p = detectPlatform(feed.url, feed.category)
  if (p === "wechat") return true
  const en = enrichments[entry.id]
  const qs = en?.qualityScore
  return qs != null && qs >= SCORE_GATE_THRESHOLD
}

function scoreValue(en: CachedEnrichment | undefined): number | null {
  const value = Number(en?.qualityScore)
  return Number.isFinite(value) ? Math.round(value) : null
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (const [i, av] of a.entries()) {
    const bv = b[i]!
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0
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
    } catch {
      /* skip */
    }
  }
  allEntries.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
  return allEntries
}

function buildClusterLeaders(entries: CachedEntry[], enrichments: EnrichmentMap) {
  const items = entries
    .map((entry) => {
      const embedding = enrichments[entry.id]?.embedding
      return embedding && embedding.length > 0
        ? {
            id: entry.id,
            vec: embedding,
            time: new Date(entry.publishedAt).getTime(),
            feedId: entry.feedId,
          }
        : null
    })
    .filter(
      (item): item is { id: string; vec: number[]; time: number; feedId: string } =>
        item !== null && Number.isFinite(item.time),
    )

  const memberOf: Record<string, string> = {}
  const leaders: Record<string, string[]> = {}

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (memberOf[item.id]) continue
    const ids = [item.id]
    for (let j = i + 1; j < items.length; j++) {
      const other = items[j]!
      if (memberOf[other.id]) continue
      if (item.feedId === other.feedId) continue
      if (Math.abs(item.time - other.time) > TOPIC_CLUSTER_TIME_WINDOW_MS) continue
      if (cosineSimilarity(item.vec, other.vec) >= TOPIC_SIMILARITY_THRESHOLD) {
        ids.push(other.id)
        memberOf[other.id] = item.id
      }
    }
    if (ids.length > 1) leaders[item.id] = ids
  }

  return leaders
}

function buildPublicTopics(
  allEntries: CachedEntry[],
  enrichments: EnrichmentMap,
  feedMap: Record<string, CachedFeed>,
  limit = 20,
) {
  const cutoff = Date.now() - TOPIC_RECENT_WINDOW_MS
  const recentEntries = allEntries.filter(
    (entry) => new Date(entry.publishedAt).getTime() >= cutoff,
  )
  const entryMap = new Map(recentEntries.map((entry) => [entry.id, entry]))
  let leaders = buildClusterLeaders(recentEntries, enrichments)

  if (Object.keys(leaders).length === 0) {
    const buckets: Record<string, string[]> = {}
    for (const entry of recentEntries) {
      const tags = enrichments[entry.id]?.tags ?? []
      const firstTag = tags[0]
      const key = firstTag || stripHtmlToText(entry.title).slice(0, 12)
      if (!key) continue
      buckets[key] ??= []
      buckets[key]!.push(entry.id)
    }
    leaders = Object.fromEntries(Object.entries(buckets).filter(([, ids]) => ids.length > 1))
  }

  return Object.entries(leaders)
    .map(([id, ids]) => {
      const entries = ids
        .map((entryId) => entryMap.get(entryId))
        .filter((entry): entry is CachedEntry => !!entry)
      if (entries.length < 2) return null

      const sourceIds = [...new Set(entries.map((entry) => entry.feedId))]
      const times = entries
        .map((entry) => new Date(entry.publishedAt).getTime())
        .filter(Number.isFinite)
      const scores = entries
        .map((entry) => scoreValue(enrichments[entry.id]))
        .filter((score): score is number => score !== null)
      const leader =
        entries
          .slice()
          .sort(
            (a, b) => (scoreValue(enrichments[b.id]) ?? 0) - (scoreValue(enrichments[a.id]) ?? 0),
          )[0] ?? entries[0]!
      const latestAt =
        times.length > 0 ? Math.max(...times) : new Date(leader.publishedAt).getTime()
      const earliestAt = times.length > 0 ? Math.min(...times) : latestAt
      const avgQualityScore =
        scores.length > 0
          ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
          : null
      const sourceCount = sourceIds.length
      const heat =
        Math.pow(sourceCount, 1.5) *
        (Date.now() - latestAt > 86_400_000
          ? 0.25
          : Date.now() - latestAt > 43_200_000
            ? 0.5
            : Date.now() - latestAt > 3_600_000
              ? 0.75
              : 1) *
        Math.log2(entries.length + 1)

      return {
        id,
        leaderId: leader.id,
        title: leader.title ?? "(无标题)",
        sourceCount,
        sources: sourceIds.map(
          (feedId) => feedMap[feedId]?.title || feedMap[feedId]?.url || feedId,
        ),
        entryCount: entries.length,
        entries: entries.map((entry) => entry.id),
        entryIds: entries.map((entry) => entry.id),
        earliestAt: new Date(earliestAt).toISOString(),
        latestAt: new Date(latestAt).toISOString(),
        publishedAt: new Date(latestAt).toISOString(),
        avgQualityScore,
        qualityScore: avgQualityScore,
        selected: deriveSelected({ qualityScore: avgQualityScore }),
        summary: enrichments[leader.id]?.summary ?? null,
        tags: enrichments[leader.id]?.tags ?? [],
        heat,
      }
    })
    .filter((topic): topic is NonNullable<typeof topic> => !!topic)
    .sort((a, b) => b.heat - a.heat)
    .slice(0, limit)
}

/** Build RSS 2.0 XML from entries */
function buildRssXml(
  title: string,
  description: string,
  link: string,
  entries: CachedEntry[],
  enrichments: EnrichmentMap,
  feedMap: Record<string, CachedFeed>,
  siteBase = PUBLIC_SITE_BASE,
): string {
  let items = ""
  for (const e of entries.slice(0, 100)) {
    const en = enrichments[e.id]
    const feedTitle = feedMap[e.feedId]?.title ?? ""
    const summary = en?.summary ?? ""
    const reason = en?.recommendationReason ?? ""
    const sel = deriveSelected(en ?? {})
    const scoreLabel = selectionLabel(sel, en?.qualityScore ?? null)
    const itemUrl = publicUrl(`/items/${encodeURIComponent(e.id)}`, siteBase)
    const sourceUrl = e.url && isSafeDetailUrl(e.url, "href") ? e.url : ""

    let desc = ""
    if (scoreLabel) desc += `【${scoreLabel}】`
    if (reason) desc += `${reason} `
    if (summary) desc += summary
    if (!desc) desc = e.description ?? ""
    desc = desc.slice(0, 500)

    items += `<item>
<title>${escapeXml(e.title ?? "")}</title>
<link>${escapeXml(itemUrl)}</link>
<guid isPermaLink="true">${escapeXml(itemUrl)}</guid>
<pubDate>${new Date(e.publishedAt).toUTCString()}</pubDate>
<description>${escapeXml(desc)}</description>
<author>${escapeXml(e.author ?? feedTitle)}</author>
${sourceUrl ? `<source url="${escapeXml(sourceUrl)}">${escapeXml(feedTitle)}</source>` : ""}
${en?.tags?.length ? en.tags.map((t) => `<category>${escapeXml(t)}</category>`).join("") : ""}
</item>\n`
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${escapeXml(title)}</title>
<link>${escapeXml(publicUrl(link, siteBase))}</link>
<description>${escapeXml(description)}</description>
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
      content: stripHtmlNL(content + retweetBlock),
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

      // Auto-import Weibo feeds from watchlist.json via RSSHub on startup
      autoImportWeiboFeeds()
        .then((n) => {
          if (n > 0) console.info(`[FinHot] Auto-imported ${n} Weibo feeds via RSSHub`)
        })
        .catch(() => {
          /* RSSHub unavailable — skip silently */
        })

      // Periodic Weibo re-import (every 30 min)
      setInterval(() => {
        autoImportWeiboFeeds().catch(() => {
          /* skip */
        })
      }, WEIBO_IMPORT_INTERVAL_MS)

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
              : /mp\.weixin/i.test(url) || /:8090/.test(url)
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
            entries = entries.filter((e) => {
              const feed = manifest.feeds[e.feedId]
              const p = detectPlatform(feed?.url, feed?.category)
              if (p === "wechat") return true
              return deriveSelected(enrichments[e.id] ?? {}) === "selected"
            })
          } else if (filter === "watch") {
            entries = entries.filter((e) => {
              const sel = deriveSelected(enrichments[e.id] ?? {})
              return sel === "selected" || sel === "watch"
            })
          }

          // Platform-aware score gate: WeChat bypasses, others need score >= threshold
          entries = entries.filter((e) => passesScoreGateServer(e, enrichments, manifest))

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
          const topics = buildPublicTopics(allEntries, enrichments, manifest.feeds, 20)

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
      server.middlewares.use("/feed.xml", async (req, res) => {
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
            publicRequestBase(req),
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
      server.middlewares.use("/feed/all.xml", async (req, res) => {
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
            publicRequestBase(req),
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
      server.middlewares.use("/feed/daily.xml", async (req, res) => {
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
            publicRequestBase(req),
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

      // ─── /api/public/item/:id — Single item detail JSON ───
      server.middlewares.use("/api/public/item/", async (req, res) => {
        if (handleCors(req, res)) return
        if (req.method !== "GET") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }
        try {
          const itemId = decodeURIComponent((req.url ?? "/").replace(/^\//, "").split("?")[0])
          if (!itemId) {
            res.writeHead(400, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ error: "Missing item ID" }))
            return
          }

          const allEntries = loadAllCachedEntries()
          const entry = allEntries.find((e) => e.id === itemId)
          if (!entry) {
            res.writeHead(404, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ error: "Item not found" }))
            return
          }

          const enrichments = readEnrichments()
          const manifest = readManifest()
          const en = enrichments[entry.id] ?? {}
          const feed = manifest.feeds[entry.feedId]

          // Find related entries (same cluster)
          const relatedIds = en.relatedEntryIds ?? []
          const related = relatedIds
            .map((rid) => {
              const re = allEntries.find((x) => x.id === rid)
              if (!re) return null
              const ren = enrichments[re.id] ?? {}
              return {
                id: re.id,
                title: re.title,
                url: re.url,
                publishedAt: re.publishedAt,
                feedTitle: manifest.feeds[re.feedId]?.title ?? null,
                qualityScore: ren.qualityScore ?? null,
              }
            })
            .filter(Boolean)

          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=120",
          })
          res.end(
            JSON.stringify({
              id: entry.id,
              title: entry.title,
              url: entry.url,
              publishedAt: entry.publishedAt,
              author: entry.author,
              description: entry.description,
              content: entry.content,
              feedId: entry.feedId,
              feedTitle: feed?.title ?? null,
              feedCategory: feed?.category ?? null,
              feedUrl: feed?.url ?? null,
              summary: en.summary ?? null,
              recommendationReason: en.recommendationReason ?? null,
              qualityScore: en.qualityScore ?? null,
              selected: deriveSelected(en),
              tags: en.tags ?? [],
              translation: en.translation ?? null,
              qualityDetails: en.qualityDetails ?? null,
              clusterId: en.clusterId ?? null,
              relatedEntries: related,
            }),
          )
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })

      // ─── /items/:id — Static HTML detail page (permalink for sharing) ───
      server.middlewares.use("/items/", async (req, res) => {
        try {
          const itemId = decodeURIComponent((req.url ?? "/").replace(/^\//, "").split("?")[0])
          if (!itemId) {
            res.writeHead(400, { "Content-Type": "text/plain" })
            res.end("Missing item ID")
            return
          }

          const allEntries = loadAllCachedEntries()
          const entry = allEntries.find((e) => e.id === itemId)
          if (!entry) {
            res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" })
            res.end(
              `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Not Found</title></head><body style="font-family:system-ui;padding:40px;text-align:center"><h1>404</h1><p>Item not found</p><a href="/public">Back to FinHot</a></body></html>`,
            )
            return
          }

          const enrichments = readEnrichments()
          const manifest = readManifest()
          const en = enrichments[entry.id] ?? {}
          const feed = manifest.feeds[entry.feedId]

          const html = buildItemDetailHtml(
            entry,
            en,
            feed ?? null,
            allEntries,
            enrichments,
            manifest,
          )
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=120",
            "Content-Security-Policy":
              "default-src 'self'; img-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          })
          res.end(html)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(500, { "Content-Type": "text/plain" })
          res.end(message)
        }
      })

      // ─── /api/public/refresh-weibo — Manually trigger Weibo feed refresh ───
      server.middlewares.use("/api/public/refresh-weibo", async (req, res) => {
        if (handleCors(req, res)) return
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }
        try {
          const count = await autoImportWeiboFeeds()
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(JSON.stringify({ ok: true, imported: count }))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Weibo refresh failed"
          res.writeHead(502, { "Content-Type": "application/json" })
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

// ─── Item detail page HTML builder ───
function buildItemDetailHtml(
  entry: CachedEntry,
  en: CachedEnrichment,
  feed: CachedFeed | null,
  allEntries: CachedEntry[],
  enrichments: EnrichmentMap,
  manifest: FeedCacheManifest,
): string {
  const esc = (s: string) =>
    s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")

  const score = en.qualityScore ?? null
  const sel = deriveSelected(en)
  const selText =
    sel === "selected" && score != null
      ? `精选 ${score}`
      : sel === "watch" && score != null
        ? `观察 ${score}`
        : ""
  const reason = en.recommendationReason ?? ""
  const summary = en.summary ?? ""
  const tags = en.tags ?? []
  const translation = en.translation ?? null
  const translatedBody =
    translation?.readabilityContent || translation?.content || translation?.description || ""
  const relatedIds = en.relatedEntryIds ?? []
  const related = relatedIds
    .map((rid) => {
      const re = allEntries.find((x) => x.id === rid)
      if (!re) return null
      const ren = enrichments[re.id] ?? {}
      return { entry: re, en: ren, feed: manifest.feeds[re.feedId] ?? null }
    })
    .filter(Boolean) as { entry: CachedEntry; en: CachedEnrichment; feed: CachedFeed | null }[]

  const pubDate = entry.publishedAt ? new Date(entry.publishedAt).toLocaleString("zh-CN") : ""
  const contentSource = entry.content || entry.description || ""
  const contentDuplicatesTitle = isSubstantiallyDuplicateText(entry.title, contentSource)
  const contentHtml = contentDuplicatesTitle ? "" : sanitizeDetailHtml(contentSource)

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<title>${esc(entry.title ?? "FinHot Detail")}</title>
<meta name="description" content="${esc(summary || (entry.description ?? "").slice(0, 160))}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#fafbfc;color:#1a1a2e;line-height:1.7;padding:0 16px}
.container{max-width:720px;margin:0 auto;padding:32px 0 64px}
.back{display:inline-flex;align-items:center;gap:4px;font-size:13px;color:#666;text-decoration:none;margin-bottom:20px;padding:4px 8px;border-radius:6px}
.back:hover{background:#f0f0f0;color:#333}
.badge{display:inline-block;font-size:12px;font-weight:700;padding:2px 8px;border-radius:4px;margin-bottom:12px}
.badge-selected{background:rgba(52,199,89,.15);color:#22863a;border:1px solid rgba(52,199,89,.25)}
.badge-watch{background:rgba(255,204,0,.12);color:#996800;border:1px solid rgba(255,204,0,.2)}
h1{font-size:28px;font-weight:800;line-height:1.3;margin-bottom:14px;color:#111;letter-spacing:-.01em}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;color:#666;margin-bottom:20px}
.meta a{color:#0066cc;text-decoration:none}
.meta a:hover{text-decoration:underline}
.section{margin-bottom:24px;padding:18px 20px;border-radius:12px;border:1px solid #e8e8ec;border-left:3px solid #e8e8ec}
.section-title{font-size:13px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px}
.reason{background:linear-gradient(135deg,rgba(88,86,214,.04),rgba(52,199,89,.04));border-color:rgba(88,86,214,.15);border-left:3px solid rgba(88,86,214,.45)}
.reason .section-title{color:#5856d6}
.summary-text{font-size:15px;line-height:1.75;color:#333}
.translation{background:rgba(0,122,255,.03);border-color:rgba(0,122,255,.12);border-left:3px solid rgba(0,122,255,.4)}
.translation .section-title{color:#007aff}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:20px}
.tag{font-size:12px;padding:3px 9px;border-radius:4px;background:#f0f0f5;color:#555}
.scores-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.score-item{text-align:center;padding:8px;border-radius:8px;background:#f8f8fa}
.score-item .val{font-size:18px;font-weight:700;color:#333}
.score-item .lbl{font-size:11px;color:#888;margin-top:2px}
.related{margin-top:32px}
.related h3{font-size:15px;font-weight:700;margin-bottom:12px;color:#333}
.related-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;border:1px solid #e8e8ec;margin-bottom:8px;text-decoration:none;color:inherit;transition:background .15s}
.related-item:hover{background:#f5f5f8}
.related-title{flex:1;font-size:13px;font-weight:550;color:#222}
.related-meta{font-size:11px;color:#888;white-space:nowrap}
.content-body{font-size:15px;line-height:1.8;color:#444}
.content-body img{max-width:100%;border-radius:8px;margin:12px 0}
.cta{display:inline-flex;align-items:center;gap:6px;margin-top:16px;padding:8px 16px;border-radius:8px;background:#0066cc;color:#fff;text-decoration:none;font-size:13px;font-weight:600}
.cta:hover{background:#0052a3}
.footer{margin-top:48px;padding-top:24px;border-top:1px solid #eee;text-align:center;font-size:12px;color:#aaa}
@media(prefers-color-scheme:dark){
  body{background:#0d0d12;color:#e0e0e8}
  h1{color:#f0f0f5}
  .meta{color:#999}
  .section{border-color:#2a2a35;background:#14141c}
  .reason{background:linear-gradient(135deg,rgba(88,86,214,.08),rgba(52,199,89,.06));border-color:rgba(88,86,214,.2)}
  .translation{background:rgba(0,122,255,.06);border-color:rgba(0,122,255,.15)}
  .summary-text{color:#ccc}
  .tag{background:#1e1e28;color:#aaa}
  .score-item{background:#1a1a24}
  .score-item .val{color:#eee}
  .related-item{border-color:#2a2a35}
  .related-item:hover{background:#1a1a24}
  .related-title{color:#ddd}
  .content-body{color:#bbb}
  .back:hover{background:#1a1a24;color:#ddd}
}
</style>
</head>
<body>
<div class="container">
<a class="back" href="/public">&larr; Back to FinHot</a>
${selText ? `<div class="badge badge-${sel}">${esc(selText)}</div>` : ""}
<h1>${esc(entry.title ?? "(无标题)")}</h1>
<div class="meta">
${feed ? `<span>${esc(feed.title ?? "")}</span>` : ""}
${entry.author ? `<span>${esc(entry.author)}</span>` : ""}
${pubDate ? `<span>${esc(pubDate)}</span>` : ""}
</div>
${
  tags.length > 0
    ? `<div class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>`
    : ""
}
${
  reason
    ? `<div class="section reason"><div class="section-title">精选理由</div><div class="summary-text">${esc(reason)}</div></div>`
    : ""
}
${
  summary
    ? `<div class="section"><div class="section-title">AI 摘要</div><div class="summary-text">${esc(summary)}</div></div>`
    : ""
}
${
  translatedBody
    ? `<div class="section translation"><div class="section-title">AI 翻译 · 中文</div><div class="summary-text">${esc(translatedBody)}</div></div>`
    : ""
}

${contentHtml ? `<div class="section"><div class="section-title">原文摘录</div><div class="content-body">${contentHtml}</div></div>` : ""}
${entry.url ? `<a class="cta" href="${esc(entry.url)}" target="_blank" rel="noopener">阅读原文 &rarr;</a>` : ""}
${
  related.length > 0
    ? `<div class="related"><h3>同一事件 · ${related.length} 篇相关报道</h3>${related
        .map(
          (r) =>
            `<a class="related-item" href="/items/${encodeURIComponent(r.entry.id)}"><span class="related-title">${esc(r.entry.title ?? "(无标题)")}</span><span class="related-meta">${esc(r.feed?.title ?? "")} · ${r.entry.publishedAt ? new Date(r.entry.publishedAt).toLocaleDateString("zh-CN") : ""}</span></a>`,
        )
        .join("")}</div>`
    : ""
}
<div class="footer">FinHot · AI 精选金融资讯</div>
</div>
</body>
</html>`
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
<link rel="icon" href="data:image/png;base64,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VqmdfFatDSIeY80T6TRjcPtZasR83CIGs2qRbDxVmyWQWv8NzEaGDJAQTZnaJnJr/QoTalRm4H8jlW5pjFqvOgAAAohlWElmSUkqAAgAAAADAA4BAgAMAQAAMgAAADsBAgAlAAAAPgEAAGmHBAABAAAAYwEAAAAAAABTaWduYXR1cmU6IFl0ZGovaVBJVU8yRVFITkZTTTJFTUNHeVpGVXo1dnl0dnJUQlpzVytVcXp3RDYxZnpBQlowMlhmcUgwa0NITXVzQUV3dUlUcUp5SnZwME80bEU5NlA3UzVPN0I3V3d5bGRISUQxT0dMRG11V1hCdThRMkFYMDJRUjBVRUY4bURGODVJWmlJM0tHKzNSbE1zQnQ4YkZMcUZJRldCc0NuQUNJbmtDRkFycDRIZDdnUS9zNUFMd1J0dXdhSFg5K0FMUXB0K2w2MUJZTW52UEx1bTdXSWRrRENtUlB3ZzFpc3h1aHpHN2xxUlR4dFpPWkVZSy93Z25DNTFRT0grTEN6K1QAY2JhNGQ4MTMtZGU1Ni00MGIyLTgwZTQtMGE5NjYwOTY5NTVjAAEAhpIHABMBAAB1AQAAAAAAAEFTQ0lJAAAAU2lnbmF0dXJlOiBZdGRqL2lQSVVPMkVRSE5GU00yRU1DR3laRlV6NXZ5dHZyVEJac1crVXF6d0Q2MWZ6QUJaMDJYZnFIMGtDSE11c0FFd3VJVHFKeUp2cDBPNGxFOTZQN1M1TzdCN1d3eWxkSElEMU9HTERtdVdYQnU4UTJBWDAyUVIwVUVGOG1ERjg1SVppSTNLRyszUmxNc0J0OGJGTHFGSUZXQnNDbkFDSW5rQ0ZBcnA0SGQ3Z1EvczVBTHdSdHV3YUhYOStBTFFwdCtsNjFCWU1udlBMdW03V0lka0RDbVJQd2cxaXN4dWh6RzdscVJUeHRaT1pFWUsvd2duQzUxUU9IK0xDeitUh1hm3QAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNi0yNFQxODozOTo0MSswMDowMGN6kb8AAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDYtMjRUMTg6Mzk6NDErMDA6MDASJykDAAAAMHRFWHRleGlmOkFydGlzdABjYmE0ZDgxMy1kZTU2LTQwYjItODBlNC0wYTk2NjA5Njk1NWMfaem6AAAAE3RFWHRleGlmOkV4aWZPZmZzZXQAMzU1k9WcLwAAAQV6VFh0ZXhpZjpJbWFnZURlc2NyaXB0aW9uAAAYlQXBR3KDMAAAwK/kzoFiU5ybJCQkG0Ifys0ZYkIoQ5GQ4fXZTbt2enKx/nx+VLz5U7uI5aGBY/pF0sDAAfKOmuSnuR98XzNYb4WSL6d0Lf11AlhrRvlaqNYjGogNYClYttyP+z5r4XXANyuyUzO0oV3IY2goc/XQ891RFCUUTmyAUjPiRMsxcUaXOCarO3Z5eMolGYINcueb+AthpIAbmgBiU48IWOcrbew2VjcT+DLhQj5peVOAH89cGSwdVsG0R74Y7YI1vYvGJJKt3m1v8Xt69rAk2ZvXYY2rhyrbCZl6HFLFR6eS/QO2AFcZRjwO/AAAAap6VFh0ZXhpZjpVc2VyQ29tbWVudAAAOI1NU9uRxDAIa2ULyIed8HL/jR0CkdzMJuvYRkgCTK9fPNfP/Pr508+aHw72Uryw2rl1HAvDq1aCw339NK7fc2fImfO18MqVOFFiNX7k2vOe5rflf2S8Z6wnhjOt+3eOdfHLe/vO11m8CGp3RmrRCx6TX5Bf5GPWUXuDR2IJeez9EGPvTGUZpHlfIGPdPDL9ECSaWMTcAALoS+0M17t50yYlyGGe2i4vZBCE7GvR5AlaXiHTioZQb5YwVFlAWFAXyVUptNOVLStYliL3tFooRRzMdeu9vYYiEKDUpuJqXa+qjfbha0nuBzkH1aJMaoS0+DaUzVZVQXfgQ0FCm4zwO0a5v04aawycQ0y3MZJdVg3ic1u7LNXDpl+/18ZXNZ52X8N/+O43fdMZBSiVoQMlCGoGh4z/zcjpsQEM7FK238TEZq6KkYdypw3BP87IX2yOeCU7zZ2Cl6r1qgoKXyQWa3oCQrrPlUr2vV5EYe+jFK07aHChyHubc4EeOjPQp8so/j9Xe+9tmMzcHw7Pw/Zz5q0BlT/UI9Kfa9putwAAAABJRU5ErkJggg==" type="image/png">
<style>
@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
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
body{font-family:system-ui,"SN Pro","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;background:hsl(var(--background));color:rgba(var(--color-text));line-height:1.56;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;font-feature-settings:"cv02","cv03","cv04","cv11"}
a{color:inherit;text-decoration:none}.app{display:flex;height:100vh;overflow:hidden;background:hsl(var(--background))}
.sidebar{width:256px;flex:0 0 256px;margin:8px;height:calc(100vh - 16px);border-radius:16px;background:rgb(247,247,247);box-shadow:0 1px 3px rgba(0,0,0,.04),0 12px 32px -26px rgba(0,0,0,.32);display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(0,0,0,.04)}
[data-theme="dark"] .sidebar{background:hsl(var(--fo-sidebar));box-shadow:0 18px 40px -24px rgba(0,0,0,.85);border-color:rgba(255,255,255,.06)}
[data-theme="dark"] .card{border-color:rgba(255,255,255,.06);border-left-color:hsl(var(--fo-a) / .3);background:hsl(var(--background))}
[data-theme="dark"] .card:hover{border-color:hsl(var(--fo-a) / .45);background:linear-gradient(hsl(var(--background)),color-mix(in srgb,hsl(var(--background)) 94%,#1e3a5f));box-shadow:0 1px 2px rgba(0,0,0,.2),0 16px 32px rgba(0,0,0,.3)}
[data-theme="dark"] .card.open{border-color:hsl(var(--fo-a) / .45);background:linear-gradient(hsl(var(--background)),color-mix(in srgb,hsl(var(--background)) 96%,#1e3a5f));box-shadow:0 1px 2px rgba(0,0,0,.15),0 8px 24px rgba(0,0,0,.2)}
.brand{height:40px;display:flex;align-items:center;justify-content:space-between;margin:0 12px 0 16px;gap:8px}.brand-main{display:flex;align-items:center;gap:8px;min-width:0}.brand-mark{width:26px;height:26px;border-radius:7px;overflow:hidden;flex:0 0 26px}.brand-mark img{width:100%;height:100%;object-fit:cover}.brand-title{font-size:17px;font-weight:760;color:hsl(var(--fo-a));letter-spacing:-.02em}.brand-sub{display:none}
.brand-tools{display:flex;align-items:center;gap:6px;color:rgba(var(--color-textSecondary))}.brand-tool{width:24px;height:24px;border:0;border-radius:7px;background:transparent;color:inherit;display:flex;align-items:center;justify-content:center;cursor:pointer}.brand-tool:hover{background:rgba(var(--color-fillSecondary));color:rgba(var(--color-text))}
.side-scroll{flex:1;overflow:auto;margin-top:12px;padding:0 8px 10px;scrollbar-width:thin}.nav-section{height:28px;display:flex;align-items:center;padding:12px 10px 4px;font-size:12px;font-weight:650;color:rgba(var(--color-textTertiary));letter-spacing:.02em}
.nav-item{width:100%;height:44px;border:0;background:transparent;border-radius:10px;color:rgba(var(--color-text));font:inherit;font-size:15px;font-weight:500;line-height:1.5;display:flex;align-items:center;gap:10px;padding:0 12px;cursor:pointer;text-align:left;transition:background .15s,color .15s}
.nav-item:hover{background:rgba(var(--color-fillSecondary));color:rgba(var(--color-text))}.nav-item.active{background:hsl(var(--fo-a) / .12);color:hsl(var(--fo-a));font-weight:650}
.nav-ico{width:22px;height:22px;display:flex;align-items:center;justify-content:center;flex:0 0 22px;opacity:.85}.nav-ico svg{width:20px;height:20px}.feed-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.count{margin-left:auto;font-size:12px;color:rgba(var(--color-textTertiary));font-variant-numeric:tabular-nums;background:rgba(var(--color-fillSecondary));padding:1px 7px;border-radius:10px}.active .count{color:hsl(var(--fo-a) / .8);background:hsl(var(--fo-a) / .08)}
.nav-divider{height:1px;margin:8px 12px;background:linear-gradient(to right,transparent,rgba(var(--color-fillSecondary)),transparent)}
.sidebar-footer{padding:8px 12px 8px;color:rgba(var(--color-textTertiary));font-size:12px}.theme-row{display:flex;gap:4px}.theme-btn{width:24px;height:24px;border:0;border-radius:7px;background:transparent;color:rgba(var(--color-textTertiary));cursor:pointer}.theme-btn.active,.theme-btn:hover{color:hsl(var(--fo-a));background:hsl(var(--fo-a) / .08)}
.main{flex:1;min-width:0;display:flex;flex-direction:column;background:hsl(var(--background));overflow:hidden}.topbar{height:52px;display:flex;align-items:center;justify-content:space-between;padding:8px 20px 0 12px;border-bottom:1px solid transparent}
.title-wrap{min-width:0}.header-title{font-size:16px;font-weight:720;letter-spacing:-.01em}.header-sub{margin-top:1px;font-size:11px;color:rgba(var(--color-textTertiary));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tools{display:flex;align-items:center;gap:6px}.tool-btn{width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:rgba(var(--color-textTertiary));display:flex;align-items:center;justify-content:center;cursor:pointer}.tool-btn:hover{background:rgba(var(--color-fillSecondary));color:rgba(var(--color-text))}
.tabs{display:flex;align-items:center;gap:4px;padding:7px 16px;border-bottom:1px solid rgba(var(--color-fillTertiary));overflow:auto;flex:0 0 auto}.tab{height:28px;padding:0 12px;border-radius:8px;border:1px solid transparent;background:transparent;color:rgba(var(--color-textSecondary));font:inherit;font-size:12px;font-weight:520;cursor:pointer;white-space:nowrap;transition:all .18s ease}.tab:hover{background:rgba(var(--color-fillSecondary));color:rgba(var(--color-text))}.tab.active{border-color:hsl(var(--fo-a) / .25);background:hsl(var(--fo-a) / .1);color:hsl(var(--fo-a));font-weight:650}
.content-area{display:flex;flex:1;min-height:0;overflow:hidden}
.entry-list{flex:1;min-width:0;overflow-y:auto;padding:8px 12px 32px;scrollbar-width:thin;transition:flex .2s ease}
.date-header{padding:20px 0 8px 0;font-size:13px;font-weight:650;color:rgba(var(--color-textSecondary));letter-spacing:.02em;display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;transition:color .18s}.date-header:hover{color:rgba(var(--color-text))}.date-header svg{width:15px;height:15px;opacity:.5;flex-shrink:0}.date-header .dh-arrow{width:12px;height:12px;margin-left:2px;transition:transform .25s ease;opacity:.4}.date-header.collapsed .dh-arrow{transform:rotate(-90deg)}.date-group.collapsed .tl-row{display:none}
.tl-row{display:flex;align-items:flex-start;gap:0}
.tl-time{flex:0 0 56px;display:flex;flex-direction:row;align-items:center;justify-content:flex-end;gap:5px;padding-top:18px;padding-right:8px;font-variant-numeric:tabular-nums}
.tl-dot{width:6px;height:6px;border-radius:50%;background:#34d399;flex-shrink:0}
.tl-hm{white-space:nowrap;font-weight:600;font-size:12.5px;color:rgba(var(--color-textSecondary));letter-spacing:0;font-feature-settings:'tnum'}
.tl-card{flex:1;min-width:0}
.card{position:relative;margin:6px 0;padding:14px 16px;border:1px solid rgba(15,23,42,.08);border-left:2.5px solid hsl(var(--fo-a) / .35);border-radius:16px;background:#fff;cursor:pointer;transition:border-color .22s ease,background .22s ease,box-shadow .28s ease,transform .22s ease;animation:fadeUp .3s ease both;overflow:hidden}.card::after{content:'';position:absolute;inset:0;opacity:0;background:linear-gradient(105deg,transparent 40%,rgba(255,255,255,.5) 45%,rgba(255,255,255,.8) 50%,rgba(255,255,255,.5) 55%,transparent 60%);transition:opacity .3s ease;pointer-events:none}.card:hover{border-color:hsl(var(--fo-a) / .55);background:linear-gradient(135deg,#fff 0%,#f0f7ff 50%,#f8fbff 100%);box-shadow:0 1px 3px rgba(15,23,42,.05),0 8px 24px rgba(15,23,42,.08),0 0 0 1px hsl(var(--fo-a) / .08);transform:translateY(-2px) scale(1.003)}.card:hover::after{opacity:1;animation:cardShine .6s ease forwards}.card:active{transform:translateY(0) scale(1);transition-duration:.1s}@keyframes cardShine{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}.feed-icon{width:20px;height:20px;border-radius:7px;background:rgba(var(--color-fillSecondary));display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:rgba(var(--color-textTertiary));overflow:hidden}.feed-icon img{width:100%;height:100%;object-fit:cover}.source{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(var(--color-textSecondary));font-size:12px;font-weight:500}.time{font-size:12px;color:rgba(var(--color-textTertiary));white-space:nowrap}.q{min-width:26px;border-radius:8px;padding:2px 8px;text-align:center;font-size:12px;font-weight:720;font-variant-numeric:tabular-nums}.q-high{background:rgba(var(--color-fillTertiary));color:rgba(var(--color-textSecondary));border:1px solid rgba(var(--color-fillSecondary))}.q-medium{background:rgba(var(--color-fillTertiary));color:rgba(var(--color-textSecondary));border:1px solid rgba(var(--color-fillSecondary))}.q-low{background:rgb(var(--color-gray) / .12);color:rgba(var(--color-textSecondary));border:1px solid rgb(var(--color-gray) / .13)}.q-wrap{position:relative;display:inline-flex;flex:0 0 auto}.q-wrap:focus{outline:none}.q-wrap:hover .q-detail,.q-wrap:focus-within .q-detail{display:block}.q-detail{display:none;position:absolute;right:0;top:calc(100% + 8px);z-index:30;width:320px;max-width:min(320px,calc(100vw - 24px));padding:10px;border:1px solid hsl(var(--border));border-radius:12px;background:hsl(var(--background));box-shadow:0 10px 28px rgba(0,0,0,.12);color:rgba(var(--color-text));font-size:11px;font-weight:400;line-height:1.45}.q-detail-title{font-size:12px;font-weight:720;margin-bottom:4px}.q-detail-muted{color:rgba(var(--color-textTertiary))}.q-grid{display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;margin-top:6px}.q-types{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}.q-reasons{margin-top:6px;padding-left:14px}
.card.open{border-color:hsl(var(--fo-a) / .5);background:linear-gradient(#fff,#f8fbff);box-shadow:0 1px 2px rgba(15,23,42,.06),0 8px 24px rgba(15,23,42,.06)}.card-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:15.5px;font-weight:640;letter-spacing:-.01em;line-height:1.48;color:rgba(var(--color-text));word-break:break-word;text-decoration:none;transition:color .18s ease}.card-title:hover{color:hsl(var(--fo-a))}button.card-title{width:100%;border:0;background:transparent;text-align:left;font-family:inherit;cursor:pointer;padding:0}.desc{margin-top:12px;font-size:13.5px;font-weight:400;line-height:1.65;color:rgba(var(--color-textSecondary));display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;letter-spacing:.005em}.card-reason{margin-top:12px;padding:4px 10px;border:0;border-radius:8px;background:rgba(52,211,153,.08);color:#047857;font-size:12px;font-weight:480;line-height:1.58;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}.card-foot{display:flex;align-items:center;gap:6px;margin-top:11px;padding-top:0}.tags{display:flex;flex-wrap:wrap;gap:6px;min-width:0;flex:1}.tag{border-radius:6px;background:rgba(var(--color-fillSecondary));color:rgba(var(--color-textSecondary));font-size:11.5px;padding:2px 7px;font-weight:500;letter-spacing:.01em}.tag-analysis,.tag-fen-xi,.tag-industry,.tag-hang-ye,.tag-business,.tag-shang-ye,.tag-opinion,.tag-guan-dian,.tag-kuai-xun,.tag-tech,.tag-ai{background:rgba(var(--color-fillSecondary));color:rgba(var(--color-textSecondary))}.cluster{border:0;border-radius:6px;background:rgb(var(--color-blue) / .09);color:rgb(var(--color-blue));font:inherit;font-size:12px;padding:3px 8px;cursor:pointer}.cluster.on{background:hsl(var(--fo-a) / .13);color:hsl(var(--fo-a))}.member{margin-left:24px;opacity:.9}.ai-panel{margin-top:10px;border-radius:12px;border:1px solid hsl(var(--fo-a) / .18);background:linear-gradient(135deg,hsl(var(--fo-a) / .07),transparent 52%),rgba(var(--color-fillQuaternary));box-shadow:0 8px 24px rgba(0,0,0,.045);overflow:hidden}.ai-card{padding:12px}.ai-head{display:flex;align-items:center;justify-content:space-between;gap:8px;color:hsl(var(--fo-a));font-size:12px;font-weight:720}.ai-title{display:flex;align-items:center;gap:6px}.ai-dot{width:8px;height:8px;border-radius:999px;background:hsl(var(--fo-a));box-shadow:0 0 0 4px hsl(var(--fo-a) / .12)}.ai-body{margin-top:9px;color:rgba(var(--color-text));font-size:13px;line-height:1.62;white-space:pre-wrap;word-break:break-word}.ai-section{border-top:1px solid hsl(var(--border) / .62);padding:12px}.ai-section-title{font-size:12px;font-weight:720;color:rgba(var(--color-textSecondary));margin-bottom:7px}.ai-link{display:inline-flex;align-items:center;gap:5px;margin-top:10px;color:hsl(var(--fo-a));font-size:12px;font-weight:650}.translation-title{font-size:13px;font-weight:680;color:rgba(var(--color-text));margin-bottom:6px}
.detail-panel{display:none;flex:0 0 500px;min-width:0;max-width:520px;overflow-y:auto;scrollbar-width:thin;background:hsl(var(--background))}.has-detail .detail-panel{display:flex;flex-direction:column}.detail-header{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:8px;padding:10px 18px;background:hsl(var(--background));border-bottom:1px solid rgba(var(--color-fillTertiary))}.detail-close-btn{width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:rgba(var(--color-textSecondary));cursor:pointer;display:flex;align-items:center;justify-content:center;flex:0 0 28px}.detail-close-btn:hover{background:rgba(var(--color-fillSecondary));color:rgba(var(--color-text))}.detail-header-title{flex:1;min-width:0;font-size:13px;font-weight:600;color:rgba(var(--color-textSecondary));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.detail-header-tools{display:flex;gap:4px}.detail-header-tools a,.detail-header-tools button{width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:rgba(var(--color-textSecondary));cursor:pointer;display:flex;align-items:center;justify-content:center;text-decoration:none}.detail-header-tools a:hover,.detail-header-tools button:hover{background:rgba(var(--color-fillSecondary));color:rgba(var(--color-text))}
.detail-scroll{flex:1;overflow-y:auto;padding:32px 28px 48px;scrollbar-width:thin}
.detail-title{font-size:26px;font-weight:780;line-height:1.32;color:rgba(var(--color-text));letter-spacing:-.018em;word-break:break-word}
.detail-title.long{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;font-size:22px;font-weight:760;line-height:1.32;color:rgba(var(--color-text))}
.detail-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:12px;padding-bottom:16px;border-bottom:1px solid rgba(var(--color-fillTertiary))}.detail-meta-icon{width:22px;height:22px;border-radius:6px;background:rgba(var(--color-fillSecondary));display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:750;color:rgba(var(--color-textTertiary));overflow:hidden}.detail-meta-icon img{width:100%;height:100%;object-fit:cover}.detail-meta-source{font-size:13px;font-weight:620;color:rgba(var(--color-textSecondary))}.detail-meta-dot{width:3px;height:3px;border-radius:50%;background:rgba(var(--color-textTertiary));flex:0 0 3px}.detail-meta-plat{font-size:12px;color:rgba(var(--color-textTertiary))}.detail-meta-time{font-size:12px;color:rgba(var(--color-textTertiary));display:flex;align-items:center;gap:4px}
.detail-ai{margin-top:24px;border-radius:12px;border:1px solid hsl(var(--fo-a) / .12);border-left:3px solid hsl(var(--fo-a) / .45);background:linear-gradient(135deg,hsl(var(--fo-a) / .035),transparent 54%);padding:20px 22px;overflow:hidden;box-shadow:0 2px 8px hsl(var(--fo-a) / .04)}.detail-ai-head{display:flex;align-items:center;gap:7px;color:hsl(var(--fo-a));font-size:14px;font-weight:720}.detail-ai-head svg{width:16px;height:16px;flex:0 0 16px}.detail-ai-body{margin-top:14px;font-size:15px;line-height:1.75;color:rgba(var(--color-text));white-space:pre-wrap;word-break:break-word}.detail-ai-label{margin-top:18px;font-size:12.5px;font-weight:660;color:rgba(var(--color-textSecondary))}.detail-ai-value{margin-top:6px;font-size:15px;line-height:1.72;color:rgba(var(--color-text))}
.detail-rec{margin-top:14px;padding:14px 16px;border-radius:10px;background:rgba(var(--color-fillQuaternary));border:1px solid rgba(var(--color-fillTertiary));border-left:3px solid rgba(var(--color-fillSecondary));color:rgba(var(--color-textSecondary));font-size:15px;line-height:1.68;font-weight:560}
.detail-section{margin-top:20px;padding-top:16px;border-top:1px solid rgba(var(--color-fillTertiary))}
.detail-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.detail-section-title{font-size:13px;font-weight:720;color:rgba(var(--color-textSecondary));letter-spacing:0}.detail-section-action{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;color:hsl(var(--fo-a));font-size:12px;font-weight:650;text-decoration:none}.detail-section-action:hover{text-decoration:underline}
.detail-body{font-size:15px;line-height:1.78;color:color-mix(in srgb, rgba(var(--color-text)) 84%, transparent);word-break:break-word;font-weight:400;white-space:pre-wrap}.detail-body p{margin-bottom:10px}.detail-source-note{font-size:12.5px;line-height:1.58;color:rgba(var(--color-textTertiary));background:rgba(var(--color-fillQuaternary));border:1px solid rgba(var(--color-fillTertiary));border-radius:8px;padding:8px 10px}
.detail-link{display:inline-flex;align-items:center;gap:5px;margin-top:16px;padding:8px 14px;border-radius:8px;background:hsl(var(--fo-a) / .08);color:hsl(var(--fo-a));font-size:13px;font-weight:620;text-decoration:none;border:1px solid hsl(var(--fo-a) / .16)}.detail-link:hover{background:hsl(var(--fo-a) / .14)}
.detail-qd{margin-top:16px;padding:13px 14px;border-radius:10px;border:1px solid hsl(var(--border));background:rgba(var(--color-fillQuaternary))}.detail-qd-title{font-size:12.5px;font-weight:720;margin-bottom:7px}.detail-qd-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px 12px;font-size:12.5px;color:rgba(var(--color-textSecondary))}.detail-qd-grid span{display:flex;justify-content:space-between}.detail-qd-muted{color:rgba(var(--color-textTertiary));font-size:11px;margin-top:6px}.detail-qd-reasons{margin-top:7px;padding-left:14px;font-size:12.5px;line-height:1.55;color:rgba(var(--color-textSecondary))}.detail-qd-reasons.negative{color:rgba(var(--color-textTertiary))}
.radar-wrap{display:flex;flex-direction:column;gap:8px;padding:4px 4px 26px}.radar-card{overflow:hidden;border:1px solid hsl(var(--fo-a) / .14);border-radius:12px;background:linear-gradient(135deg,hsl(var(--fo-a) / .03),transparent 46%),rgba(var(--color-fillQuaternary));box-shadow:0 2px 8px hsl(var(--fo-a) / .04),0 1px 3px rgba(0,0,0,.04);transition:box-shadow .25s ease,border-color .25s ease}.radar-card:hover{border-color:hsl(var(--fo-a) / .24);box-shadow:0 4px 16px hsl(var(--fo-a) / .08),0 2px 8px rgba(0,0,0,.05)}.radar-main{width:100%;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:flex-start;gap:10px;padding:12px}.radar-main:hover{background:rgba(var(--color-fillQuaternary))}.radar-title-row{display:flex;align-items:flex-start;gap:8px}.radar-title{flex:1;min-width:0;font-size:14px;font-weight:680;line-height:1.35}.heat{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:hsl(var(--fo-a));white-space:nowrap}.heat-dot{width:7px;height:7px;border-radius:999px;background:hsl(var(--fo-a));box-shadow:0 0 0 3px hsl(var(--fo-a) / .12)}.chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}.chip{border-radius:6px;background:rgba(var(--color-fillTertiary));color:rgba(var(--color-textSecondary));font-size:11px;padding:2px 6px}.meta{display:flex;gap:12px;margin-top:7px;color:rgba(var(--color-textTertiary));font-size:11px}.radar-chevron{width:16px;color:rgba(var(--color-textTertiary));transition:transform .15s}.radar-card.open .radar-chevron{transform:rotate(180deg)}.radar-entries{display:none;border-top:1px solid hsl(var(--fo-a) / .13);padding:7px 10px 10px}.radar-card.open .radar-entries{display:block}.radar-entry{display:flex;align-items:center;gap:8px;border-radius:8px;padding:6px 6px;color:rgba(var(--color-textSecondary));font-size:12px}.radar-entry:hover{background:rgba(var(--color-fillQuaternary));color:rgba(var(--color-text))}.radar-entry-title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty{height:300px;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;color:rgba(var(--color-textTertiary));font-size:13px}.empty svg{width:38px;height:38px;opacity:.38}
.fp-detail{display:none;position:fixed;inset:0;z-index:100;background:hsl(var(--background));overflow-y:auto;scrollbar-width:thin}
.fp-detail.open{display:block}
.fp-back{display:inline-flex;align-items:center;gap:6px;padding:14px 24px;font-size:14px;font-weight:600;color:hsl(var(--fo-a));cursor:pointer;border:0;background:transparent;position:sticky;top:0;z-index:10;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);background:hsl(var(--background) / .85)}
.fp-back:hover{opacity:.8}
.fp-back svg{width:18px;height:18px}
.fp-inner{max-width:720px;margin:0 auto;padding:0 24px 48px}
.fp-source{display:flex;align-items:center;gap:8px;margin-bottom:12px}.fp-source-icon{width:24px;height:24px;border-radius:8px;background:rgba(var(--color-fillSecondary));display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:rgba(var(--color-textTertiary));overflow:hidden}.fp-source-icon img{width:100%;height:100%;object-fit:cover}.fp-source-name{font-size:14px;font-weight:650;color:rgba(var(--color-text))}.fp-source-plat{font-size:12px;color:rgba(var(--color-textTertiary));padding:2px 8px;border-radius:4px;background:rgba(var(--color-fillSecondary))}
.fp-badges{display:flex;gap:6px;margin-bottom:14px}
.fp-title{font-size:24px;font-weight:780;line-height:1.34;color:rgba(var(--color-text));letter-spacing:-.02em;word-break:break-word;margin-bottom:10px}
.fp-date{font-size:13px;color:rgba(var(--color-textTertiary));margin-bottom:24px;display:flex;align-items:center;gap:6px}
.fp-date svg{width:14px;height:14px;opacity:.5}
.fp-section{margin-top:24px;border-radius:12px;border:1px solid rgba(var(--color-fillTertiary));overflow:hidden}
.fp-section-head{display:flex;align-items:center;gap:8px;padding:14px 18px;font-size:13px;font-weight:700;color:hsl(var(--fo-a));border-bottom:1px solid rgba(var(--color-fillTertiary));background:linear-gradient(135deg,hsl(var(--fo-a) / .04),transparent 60%)}
.fp-section-head svg{width:16px;height:16px;flex-shrink:0}
.fp-section-body{padding:16px 18px;font-size:15px;line-height:1.78;color:rgba(var(--color-text));white-space:pre-wrap;word-break:break-word}
.fp-reason{margin-top:24px;border-radius:12px;border-left:3px solid #34d399;background:rgba(52,211,153,.06);padding:16px 18px}
.fp-reason-head{font-size:13px;font-weight:700;color:#047857;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.fp-reason-head svg{width:15px;height:15px}
.fp-reason-body{font-size:15px;line-height:1.72;color:rgba(var(--color-text))}
.fp-toggle{display:inline-flex;align-items:center;gap:4px;margin-top:8px;padding:6px 12px;border-radius:8px;border:1px solid rgba(var(--color-fillTertiary));background:transparent;color:hsl(var(--fo-a));font-size:12.5px;font-weight:600;cursor:pointer;transition:background .18s}
.fp-toggle:hover{background:hsl(var(--fo-a) / .06)}
.fp-orig-link{display:inline-flex;align-items:center;gap:5px;margin-top:20px;padding:10px 16px;border-radius:10px;background:hsl(var(--fo-a) / .08);color:hsl(var(--fo-a));font-size:13px;font-weight:620;text-decoration:none;border:1px solid hsl(var(--fo-a) / .16)}.fp-orig-link:hover{background:hsl(var(--fo-a) / .14)}
.fp-article{font-size:16.5px;line-height:1.85;color:rgba(var(--color-text));word-break:break-word;-webkit-font-smoothing:antialiased;white-space:normal}
.fp-article p{margin:0 0 16px;font-weight:400}
.fp-article p:last-child{margin-bottom:0}
.fp-article h3{font-size:19px;font-weight:700;margin:36px 0 14px;padding-top:24px;border-top:1px solid rgba(var(--color-fillTertiary));color:rgba(var(--color-text));letter-spacing:-.01em;line-height:1.35}
.fp-article h3:first-child{margin-top:0;padding-top:0;border-top:0}
.fp-article h4{font-size:16.5px;font-weight:700;margin:24px 0 10px;color:rgba(var(--color-text));line-height:1.35}
.fp-article strong{background:linear-gradient(180deg,transparent 62%,rgba(var(--color-fillSecondary)) 62%);color:rgba(var(--color-text));font-weight:700;padding:0 2px;font-variant-numeric:tabular-nums}
.fp-article em{font-style:italic;color:rgba(var(--color-textSecondary))}
.fp-article ul,.fp-article ol{margin:10px 0 16px;padding-left:24px}
.fp-article li{margin-bottom:6px;font-size:16px;line-height:1.75}
.fp-article li strong{background:linear-gradient(180deg,transparent 62%,rgba(var(--color-fillSecondary)) 62%)}
.fp-article blockquote{background:rgba(var(--color-fillQuaternary));border-left:4px solid hsl(var(--fo-a));border-radius:8px;color:rgba(var(--color-text));margin:20px 0;padding:14px 18px;font-size:15.5px;line-height:1.75}
.fp-article hr{background:rgba(var(--color-fillTertiary));border:0;height:1px;margin:36px 0}
.fp-article .art-highlight{background:linear-gradient(180deg,transparent 40%,hsl(var(--fo-a) / .12) 40%);padding:0 3px;border-radius:2px;font-weight:600}
.fp-article .art-tag{display:inline-block;background:rgba(var(--color-fillSecondary));color:rgba(var(--color-textSecondary));font-size:13px;padding:2px 8px;border-radius:6px;margin:2px 3px 2px 0;font-weight:500}
.fp-article .art-sep{display:block;text-align:center;color:rgba(var(--color-textTertiary));font-size:13px;margin:28px 0;letter-spacing:.3em}
.fp-article a{color:hsl(var(--fo-a));border-bottom:1px solid hsl(var(--fo-a) / .32);font-weight:500;text-decoration:none;transition:border-color .18s}
.fp-article a:hover{border-bottom-color:hsl(var(--fo-a))}
.mobile-toggle{display:none;position:fixed;left:12px;top:10px;z-index:60;width:34px;height:34px;border:0;border-radius:8px;background:hsl(var(--background));color:rgba(var(--color-text));box-shadow:0 1px 7px rgba(0,0,0,.12)}
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.32);z-index:40}
@media(max-width:860px){.card{padding:15px 17px}.card-title{font-size:15px}.desc{font-size:13px;-webkit-line-clamp:2}.card-reason{font-size:12.5px}.tag{font-size:11.5px;padding:3px 7px}.fp-inner{padding:0 16px 40px}.fp-title{font-size:20px}.fp-article{font-size:15px}.fp-article h3{font-size:17px}.fp-article li{font-size:14.5px}}
@media(max-width:520px){.sidebar{position:fixed;inset:0 auto 0 0;z-index:50;height:100vh;margin:0;border-radius:0;transform:translateX(-100%);transition:transform .22s}.sidebar.open{transform:translateX(0)}.overlay.open{display:block}.mobile-toggle{display:flex;align-items:center;justify-content:center}.topbar{padding-left:56px}.tabs{padding-left:12px}.entry-list{padding:5px 6px 24px}.tl-time{flex:0 0 48px;padding-top:16px;gap:4px;padding-right:6px}.tl-hm{font-size:11px}.card{border-radius:12px;padding:12px 13px;margin:6px 0}.card-head{margin-bottom:7px}.card-title{font-size:14px;-webkit-line-clamp:2}.desc{font-size:12.5px;-webkit-line-clamp:2;margin-top:6px}.card-reason{font-size:12px;padding:8px 9px;margin-top:9px}.member{margin-left:12px}.fp-inner{padding:0 12px 32px}.fp-title{font-size:18px}.fp-back{padding:12px 16px;font-size:13px}.fp-section-body{font-size:14px;padding:12px 14px}.fp-reason{padding:12px 14px}}
</style>
</head>
<body>
<div class="app">
<button class="mobile-toggle" id="mobile-toggle" aria-label="菜单"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button>
<aside class="sidebar" id="sidebar">
  <div class="brand">
    <div class="brand-main"><div class="brand-mark"><img src="data:image/png;base64,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SkbLLxK0EcMyiERNtCe1p2hCuxVVjV9baoGtAlIQMZjB/w/a0QpLdsTkagAAAohlWElmSUkqAAgAAAADAA4BAgAMAQAAMgAAADsBAgAlAAAAPgEAAGmHBAABAAAAYwEAAAAAAABTaWduYXR1cmU6IFl0ZGovaVBJVU8yRVFITkZTTTJFTUNHeVpGVXo1dnl0dnJUQlpzVytVcXp3RDYxZnpBQlowMlhmcUgwa0NITXVzQUV3dUlUcUp5SnZwME80bEU5NlA3UzVPN0I3V3d5bGRISUQxT0dMRG11V1hCdThRMkFYMDJRUjBVRUY4bURGODVJWmlJM0tHKzNSbE1zQnQ4YkZMcUZJRldCc0NuQUNJbmtDRkFycDRIZDdnUS9zNUFMd1J0dXdhSFg5K0FMUXB0K2w2MUJZTW52UEx1bTdXSWRrRENtUlB3ZzFpc3h1aHpHN2xxUlR4dFpPWkVZSy93Z25DNTFRT0grTEN6K1QAY2JhNGQ4MTMtZGU1Ni00MGIyLTgwZTQtMGE5NjYwOTY5NTVjAAEAhpIHABMBAAB1AQAAAAAAAEFTQ0lJAAAAU2lnbmF0dXJlOiBZdGRqL2lQSVVPMkVRSE5GU00yRU1DR3laRlV6NXZ5dHZyVEJac1crVXF6d0Q2MWZ6QUJaMDJYZnFIMGtDSE11c0FFd3VJVHFKeUp2cDBPNGxFOTZQN1M1TzdCN1d3eWxkSElEMU9HTERtdVdYQnU4UTJBWDAyUVIwVUVGOG1ERjg1SVppSTNLRyszUmxNc0J0OGJGTHFGSUZXQnNDbkFDSW5rQ0ZBcnA0SGQ3Z1EvczVBTHdSdHV3YUhYOStBTFFwdCtsNjFCWU1udlBMdW03V0lka0RDbVJQd2cxaXN4dWh6RzdscVJUeHRaT1pFWUsvd2duQzUxUU9IK0xDeitUh1hm3QAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNi0yNFQxODozOTo0MSswMDowMGN6kb8AAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDYtMjRUMTg6Mzk6NDErMDA6MDASJykDAAAAMHRFWHRleGlmOkFydGlzdABjYmE0ZDgxMy1kZTU2LTQwYjItODBlNC0wYTk2NjA5Njk1NWMfaem6AAAAE3RFWHRleGlmOkV4aWZPZmZzZXQAMzU1k9WcLwAAAQV6VFh0ZXhpZjpJbWFnZURlc2NyaXB0aW9uAAAYlQXBR3KDMAAAwK/kzoFiU5ybJCQkG0Ifys0ZYkIoQ5GQ4fXZTbt2enKx/nx+VLz5U7uI5aGBY/pF0sDAAfKOmuSnuR98XzNYb4WSL6d0Lf11AlhrRvlaqNYjGogNYClYttyP+z5r4XXANyuyUzO0oV3IY2goc/XQ891RFCUUTmyAUjPiRMsxcUaXOCarO3Z5eMolGYINcueb+AthpIAbmgBiU48IWOcrbew2VjcT+DLhQj5peVOAH89cGSwdVsG0R74Y7YI1vYvGJJKt3m1v8Xt69rAk2ZvXYY2rhyrbCZl6HFLFR6eS/QO2AFcZRjwO/AAAAap6VFh0ZXhpZjpVc2VyQ29tbWVudAAAOI1NU9uRxDAIa2ULyIed8HL/jR0CkdzMJuvYRkgCTK9fPNfP/Pr508+aHw72Uryw2rl1HAvDq1aCw339NK7fc2fImfO18MqVOFFiNX7k2vOe5rflf2S8Z6wnhjOt+3eOdfHLe/vO11m8CGp3RmrRCx6TX5Bf5GPWUXuDR2IJeez9EGPvTGUZpHlfIGPdPDL9ECSaWMTcAALoS+0M17t50yYlyGGe2i4vZBCE7GvR5AlaXiHTioZQb5YwVFlAWFAXyVUptNOVLStYliL3tFooRRzMdeu9vYYiEKDUpuJqXa+qjfbha0nuBzkH1aJMaoS0+DaUzVZVQXfgQ0FCm4zwO0a5v04aawycQ0y3MZJdVg3ic1u7LNXDpl+/18ZXNZ52X8N/+O43fdMZBSiVoQMlCGoGh4z/zcjpsQEM7FK238TEZq6KkYdypw3BP87IX2yOeCU7zZ2Cl6r1qgoKXyQWa3oCQrrPlUr2vV5EYe+jFK07aHChyHubc4EeOjPQp8so/j9Xe+9tmMzcHw7Pw/Zz5q0BlT/UI9Kfa9putwAAAABJRU5ErkJggg==" alt="FinHot"></div><div class="brand-title">FinHot</div><div class="brand-sub">金融动态聚合</div></div>
  </div>
  <div class="side-scroll">
    <div class="nav-section">内容</div>
    <div id="smart-nav"></div>
    <div class="nav-divider"></div>
    <div class="nav-section">更多</div>
    <button class="nav-item" data-view="about"><span class="nav-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg></span><span class="feed-name">关于</span></button>
    <button class="nav-item" data-view="feedback"><span class="nav-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span><span class="feed-name">反馈</span></button>
  </div>
  <div class="sidebar-footer"><div class="theme-row"><button class="theme-btn" data-theme="light" title="浅色">L</button><button class="theme-btn" data-theme="system" title="系统">S</button><button class="theme-btn" data-theme="dark" title="深色">D</button></div></div>
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
  <div class="content-area" id="content-area">
    <div class="entry-list" id="entry-list"></div>
    <aside class="detail-panel" id="detail-panel"></aside>
  </div>
</main>
</div>
<div class="fp-detail" id="fp-detail"></div>
<script>
(function(){
var feeds=${feedsJson};
var entriesByFeed=${entriesByFeedJson};
var allEntries=${allEntriesJson};
var enrichments=${enrichmentsJson};
var feedMap={};feeds.forEach(function(f){feedMap[f.id]=f});
var selectedFeedId=null;
var activeView="smart-selected";
var activeCat="all";
var expandedGroups={};
var expandedClusters={};
var collapsedDates={};
var expandedTopicId=null;
var activeEntryId=null;

function esc(s){if(s==null)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function strip(s){if(!s)return"";var d=document.createElement("div");d.innerHTML=s;return d.textContent||""}
function stripNL(s){if(!s)return"";var h=String(s);h=h.replace(/<br\\s*\\/?>/gi,"\\n");h=h.replace(/<\\/(p|div|li|h[1-6]|blockquote|tr)>/gi,"\\n");h=h.replace(/<img[^>]*>/gi,"");var d=document.createElement("div");d.innerHTML=h;return d.textContent||""}
function genTitle(text){if(!text)return"(\u65E0\u6807\u9898)";var s=text.replace(/\\s+/g," ").trim();var m=s.match(/^[^。！？!?.]+[。！？!?.]?/);var t=m?m[0]:s.slice(0,50);if(t.length>50)t=t.slice(0,50);return t+(t.length<s.length?"\u2026":"")||"(\u65E0\u6807\u9898)"}
function genAiTitle(s){if(!s)return"";s=s.replace(/\\s+/g," ").trim();var m=s.match(/^[^。！？!?.\\n]+/);var t=m?m[0].trim():s.slice(0,50);if(t.length>50)t=t.slice(0,50)+"\u2026";return t||""}
function plain(s){return String(s||"").split(String.fromCharCode(96)).join("").replace(/\\*\\*([^*]+)\\*\\*/g,"$1").replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g,"$1").replace(/^\\s{0,3}#{1,6}\\s+/gm,"").replace(/^\\s*[-*+]\\s+/gm,"").replace(/\\s+/g," ").trim()}
function duplicateText(a,b){a=plain(strip(a)).toLowerCase();b=plain(strip(b)).toLowerCase();if(!a||!b)return false;if(a===b)return true;if(Math.min(a.length,b.length)<40)return false;return a.indexOf(b)>-1||b.indexOf(a)>-1}
function titleCore(s){return plain(s).replace(/^RT by\\s+@\\S+:\\s*/i,"").trim()}
function sourceBody(title,body){body=plain(body);var core=titleCore(title);if(!body)return{text:"",note:""};if(duplicateText(core,body))return{text:"",note:"\u539F\u6587\u5185\u5BB9\u4E0E\u6807\u9898\u76F8\u540C\uFF0C\u5DF2\u5408\u5E76\u5C55\u793A\u3002"};var prefix=core.slice(0,Math.min(160,core.length));if(prefix.length>=40&&body.indexOf(prefix)===0){var rest=body.slice(Math.min(core.length,body.length)).replace(/^[\\s,，。:：;；\\-—]+/,"").trim();if(rest.length>=40)return{text:rest,note:""};return{text:"",note:"\u539F\u6587\u5F00\u5934\u4E0E\u6807\u9898\u91CD\u590D\uFF0C\u5DF2\u5408\u5E76\u5C55\u793A\u3002"}}return{text:body,note:""}}
function when(d){var t=new Date(d).getTime();var diff=Date.now()-t;var m=Math.floor(diff/60000);if(!isFinite(t))return"";if(m<1)return"刚刚";if(m<60)return m+"分钟前";var h=Math.floor(m/60);if(h<24)return h+"小时前";var days=Math.floor(h/24);if(days<30)return days+"天前";return new Date(t).toLocaleDateString("zh-CN")}
function shortTime(t){var d=new Date(t);var hh=String(d.getHours()).padStart(2,"0");var mm=String(d.getMinutes()).padStart(2,"0");var n=new Date();if(d.toDateString()===n.toDateString())return hh+":"+mm;return (d.getMonth()+1)+"/"+d.getDate()+" "+hh+":"+mm}
function initial(s){s=String(s||"?");var c=s.charAt(0);return /[\\u4e00-\\u9fff]/.test(c)?c:c.toUpperCase()}
function scoreVal(en){if(!en)return null;var v=en.qualityScore;if(v==null)v=en.quality_score;v=Number(v);return isFinite(v)?Math.round(v):null}
function scoreTier(v){return v>=70?"high":v>=40?"medium":"low"}
function selStatus(en){var s=en&&en.selected;if(s)return s;var v=scoreVal(en);if(v==null)return null;return v>=70?"selected":v>=40?"watch":"noise"}
function selLabel(en){var st=selStatus(en);var v=scoreVal(en);if(!st||v==null)return"";if(st==="selected")return"\u7CBE\u9009 "+v;if(st==="watch")return"\u89C2\u5BDF "+v;return""}
function recReason(en){return en&&(en.recommendationReason||en.recommendation_reason)||"";}
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
function articleHtml(s){if(!s)return"";var t=esc(String(s).trim()).replace(/\\n{3,}/g,"\\n\\n");t=t.replace(/([^\\n])([\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341]+\\u3001)/g,"$1\\n$2");t=t.replace(/([^\\n\\u3001])(\\d+\\u3001)/g,"$1\\n$2");t=t.replace(/([^\\n])(No\\.\\d+)/gi,"$1\\n$2");var lines=t.split(/\\n/);var out="";var ul=0;for(var i=0;i<lines.length;i++){var ln=lines[i].trim();if(!ln){if(ul){out+="</ul>";ul=0}continue}if(/^[\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341]+[\\u3001.]/.test(ln)){if(ul){out+="</ul>";ul=0}out+="<h3>"+artHL(ln)+"</h3>";continue}if(/^[\\uff08(][\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341]+[\\uff09)]/.test(ln)){if(ul){out+="</ul>";ul=0}out+="<h4>"+artHL(ln)+"</h4>";continue}if(/^No\\.\\d+$/i.test(ln)){if(ul){out+="</ul>";ul=0}out+='<span class="art-sep">'+ln+'</span>';continue}if(/^\\d{1,2}\\u3001/.test(ln)){if(!ul){out+="<ul>";ul=1}out+="<li>"+artHL(ln.replace(/^\\d{1,2}\\u3001\\s*/,""))+"</li>";continue}if(/^[\\xb7\\u2022\\-]\\s/.test(ln)){if(!ul){out+="<ul>";ul=1}out+="<li>"+artHL(ln.replace(/^[\\xb7\\u2022\\-]\\s+/,""))+"</li>";continue}if(ul){out+="</ul>";ul=0}out+="<p>"+artHL(ln)+"</p>"}if(ul)out+="</ul>";return out}
function artHL(s){return s.replace(/\\u300a([^\\u300b]+)\\u300b/g,"<strong>\\u300a$1\\u300b</strong>").replace(/\\u3010([^\\u3011]+)\\u3011/g,"<strong>\\u3010$1\\u3011</strong>")}
function translationText(en){
  var tr=en&&(en.translation||en.translated);if(!tr)return"";
  return tr.readabilityContent||tr.content||tr.description||"";
}
function tagColorClass(t){var s=String(typeof t==="object"?(t.label||t.name||"*"):t).toLowerCase();if(s==="\u5206\u6790"||s==="analysis")return" tag-fen-xi";if(s==="\u884C\u4E1A"||s==="industry")return" tag-hang-ye";if(s==="\u5546\u4E1A"||s==="business"||s==="\u5546\u52A1")return" tag-shang-ye";if(s==="\u89C2\u70B9"||s==="opinion"||s==="\u5FEB\u8BAF")return" tag-guan-dian";if(s==="ai"||s==="\u6280\u672F"||s==="tech")return" tag-ai";return""}
function hasTranslation(en){return !!translationText(en)||!!(en&&en.translation&&(en.translation.title||en.translation.description))}
function renderDetail(entryId){
  var panel=document.getElementById("detail-panel");
  var area=document.getElementById("content-area");
  if(!entryId){area.classList.remove("has-detail");panel.innerHTML="";return}
  area.classList.add("has-detail");
  var e=allEntries.find(function(x){return x.id===entryId});if(!e){area.classList.remove("has-detail");panel.innerHTML="";return}
  var en=enrichments[e.id]||{};var f=feedMap[e.feedId]||{};
  var p=platform(f);var pLabel=platformLabel(p);
  var summary=String(en.summary||"").trim();
  var reason=recReason(en);
  var tr=en.translation||{};var translatedBody=translationText(en);
  var score=scoreVal(en);var sl=selLabel(en);
  var bodyText=strip(e.content||e.description||"").replace(/\\s+/g," ").trim();
  var titleText=String(e.title||"(\u65E0\u6807\u9898)").trim();
  var isLongTitle=plain(titleText).length>90;
  var source=sourceBody(titleText,bodyText);
  var h='<div class="detail-header">';
  h+='<button class="detail-close-btn" id="detail-close" title="\u5173\u95ED"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button>';
  h+='<span class="detail-header-title">'+esc(titleText)+"</span>";
  h+='<div class="detail-header-tools">';
  if(e.url)h+='<a href="'+esc(e.url)+'" target="_blank" rel="noopener" title="\u6253\u5F00\u539F\u6587"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg></a>';
  h+='</div></div>';
  h+='<div class="detail-scroll">';
  h+='<h1 class="detail-title'+(isLongTitle?" long":"")+'">'+esc(titleText)+'</h1>';
  h+='<div class="detail-meta"><span class="detail-meta-icon">'+(f.image?'<img src="'+esc(f.image)+'" alt="">':esc(initial(f.title||f.url)))+'</span><span class="detail-meta-source">'+esc(f.title||f.url||"")+"</span>";
  h+='<span class="detail-meta-dot"></span><span class="detail-meta-plat">'+esc(pLabel)+"</span>";
  h+='<span class="detail-meta-dot"></span><span class="detail-meta-time"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>'+when(e.publishedAt)+"</span>";
  if(sl)h+='<span class="q q-'+scoreTier(score||0)+'">'+esc(sl)+"</span>";
  h+='</div>';
  if(summary||reason||hasTranslation(en)){
    h+='<div class="detail-ai"><div class="detail-ai-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z"/></svg>AI \u603B\u7ED3</div>';
    if(summary)h+='<div class="detail-ai-body">'+textHtml(summary)+'</div>';
    if(reason)h+='<div class="detail-ai-label">\u7CBE\u9009\u7406\u7531</div><div class="detail-rec">'+textHtml(reason)+'</div>';
    if(hasTranslation(en)){
      if(tr.title)h+='<div class="detail-ai-label">\u7FFB\u8BD1\u6807\u9898</div><div class="detail-ai-value">'+textHtml(tr.title)+'</div>';
      if(translatedBody)h+='<div class="detail-ai-label">\u7FFB\u8BD1\u5185\u5BB9</div><div class="detail-ai-value">'+textHtml(translatedBody)+'</div>';
    }
    h+='</div>';
  }

  if(bodyText||e.url){
    h+='<div class="detail-section"><div class="detail-section-head"><div class="detail-section-title">\u539F\u6587</div>';
    if(e.url)h+='<a class="detail-section-action" href="'+esc(e.url)+'" target="_blank" rel="noopener">\u6253\u5F00 <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg></a>';
    h+='</div>';
    if(source.text)h+='<div class="detail-body">'+textHtml(source.text)+'</div>';
    else if(source.note)h+='<div class="detail-source-note">'+esc(source.note)+'</div>';
    else h+='<div class="detail-source-note">\u70B9\u51FB\u6253\u5F00\u67E5\u770B\u5B8C\u6574\u5185\u5BB9\u3002</div>';
    h+='</div>';
  }
  h+='</div>';
  panel.innerHTML=h;
  panel.scrollTop=0;
  var closeBtn=document.getElementById("detail-close");if(closeBtn)closeBtn.addEventListener("click",function(){activeEntryId=null;renderDetail(null);renderTimeline()});
}
function showFullDetail(entryId){
  var fp=document.getElementById("fp-detail");
  if(!entryId){fp.classList.remove("open");fp.innerHTML="";return}
  var e=allEntries.find(function(x){return x.id===entryId});
  if(!e){fp.classList.remove("open");fp.innerHTML="";return}
  var en=enrichments[e.id]||{};var f=feedMap[e.feedId]||{};
  var p=platform(f);var pLabel=platformLabel(p);
  var summary=String(en.summary||"").trim();
  var reason=recReason(en);
  var tr=en.translation||{};var translatedBody=translationText(en);
  var score=scoreVal(en);var sl=selLabel(en);
  var bodyText=stripNL(e.content||e.description||"").replace(/[ \\t\\r]+/g," ").trim();
  var titleText=strip(e.title||"").replace(/\\s+/g," ").trim();
  if(!titleText){var _src=f.title||"";var _auth=e.author||"";if(_auth&&_src&&_auth!==_src&&_src.indexOf(_auth)===-1){titleText=_src+" \u00B7 "+_auth}else{titleText=_src||_auth||"(\u65E0\u6807\u9898)"}}
  var pd=new Date(e.publishedAt);
  var dateStr=isFinite(pd.getTime())?(pd.getFullYear()+"\u5E74"+(pd.getMonth()+1)+"\u6708"+pd.getDate()+"\u65E5 "+String(pd.getHours()).padStart(2,"0")+":"+String(pd.getMinutes()).padStart(2,"0")):"";
  var h='<button class="fp-back" id="fp-back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>\u8FD4\u56DE</button>';
  h+='<div class="fp-inner">';
  h+='<div class="fp-source"><span class="fp-source-icon">'+(f.image?'<img src="'+esc(f.image)+'" alt="">':esc(initial(f.title||f.url)))+'</span><span class="fp-source-name">'+esc(f.title||f.url||"")+'</span><span class="fp-source-plat">'+esc(pLabel)+'</span></div>';
  if(sl||score!=null){h+='<div class="fp-badges">';if(sl)h+='<span class="q q-'+scoreTier(score||0)+'">'+esc(sl)+'</span>';if(score!=null)h+='<span class="q q-'+scoreTier(score)+'">'+score+'</span>';h+='</div>'}
  h+='<h1 class="fp-title">'+esc(titleText)+'</h1>';
  h+='<div class="fp-date"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>'+esc(dateStr)+(dateStr?" \u00B7 ":"")+esc(when(e.publishedAt))+'</div>';
  if(reason){h+='<div class="fp-reason"><div class="fp-reason-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.7 5.8 21 7 14.2 2 9.3l6.9-1z"/></svg>\u7CBE\u9009\u7406\u7531</div><div class="fp-reason-body">'+textHtml(reason)+'</div></div>'}
  if(summary){h+='<div class="fp-section"><div class="fp-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z"/></svg>AI \u6458\u8981</div><div class="fp-section-body">'+textHtml(summary)+'</div></div>'}
  if(hasTranslation(en)){
    h+='<div class="fp-section"><div class="fp-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>AI \u7FFB\u8BD1 \u00B7 \u4E2D\u6587</div><div class="fp-section-body" id="fp-trans-body">';
    if(tr.title)h+='<div style="font-weight:660;margin-bottom:8px">'+textHtml(tr.title)+'</div>';
    if(translatedBody)h+=textHtml(translatedBody);
    h+='</div></div>';
    if(bodyText){h+='<button class="fp-toggle" id="fp-toggle-orig">\u663E\u793A\u539F\u6587</button><div class="fp-section" id="fp-orig-section" style="display:none"><div class="fp-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>\u539F\u6587</div><div class="fp-section-body fp-article">'+articleHtml(bodyText)+'</div></div>'}
  } else if(bodyText){
    h+='<div class="fp-section"><div class="fp-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>\u539F\u6587</div><div class="fp-section-body fp-article">'+articleHtml(bodyText)+'</div></div>';
  }
  if(e.url){h+='<a class="fp-orig-link" href="'+esc(e.url)+'" target="_blank" rel="noopener">\u6253\u5F00\u539F\u6587 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg></a>'}
  h+='</div>';
  fp.innerHTML=h;fp.scrollTop=0;fp.classList.add("open");
  document.getElementById("fp-back").addEventListener("click",function(){showFullDetail(null)});
  var togBtn=document.getElementById("fp-toggle-orig");
  if(togBtn){togBtn.addEventListener("click",function(){var sec=document.getElementById("fp-orig-section");if(!sec)return;var vis=sec.style.display!=="none";sec.style.display=vis?"none":"block";togBtn.textContent=vis?"\u663E\u793A\u539F\u6587":"\u9690\u85CF\u539F\u6587"})}
}
function renderEntryInsight(e,en,f){
  var summary=String(en.summary||"").trim();
  var tr=en.translation||{};
  var translatedBody=translationText(en);
  var hasAny=summary||hasTranslation(en);
  var h='<div class="ai-panel">';
  var reason=recReason(en);
  if(reason){h+='<div class="ai-card"><div class="ai-head"><span class="ai-title"><span class="ai-dot"></span>\u7CBE\u9009\u7406\u7531</span></div><div class="ai-body">'+textHtml(reason)+'</div></div>';}
  h+='<div class="ai-card"><div class="ai-head"><span class="ai-title"><span class="ai-dot"></span>AI \u603B\u7ED3</span>';
  var score=scoreVal(en);var sl2=selLabel(en);if(sl2)h+='<span class="q q-'+scoreTier(score||0)+'">'+esc(sl2)+'</span>';else if(score!=null)h+='<span class="q q-'+scoreTier(score)+'">'+score+'</span>';
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
function platform(feed){var u=(feed&&feed.url||"").toLowerCase();var c=(feed&&feed.category||"").toLowerCase();if(u.indexOf(":8090")>=0||u.indexOf("wechat")>=0||u.indexOf("mp.weixin")>=0||c.indexOf("公众号")>=0)return"wechat";if(u.indexOf("xueqiu")>=0||c.indexOf("雪球")>=0)return"xueqiu";if(u.indexOf("twitter")>=0||u.indexOf("x.com")>=0||u.indexOf("nitter")>=0||u.indexOf("xcancel")>=0||c.indexOf("推特")>=0)return"twitter";if(u.indexOf("weibo")>=0||c.indexOf("微博")>=0)return"weibo";return"other"}
function platformLabel(p){return p==="xueqiu"?"雪球":p==="twitter"?"推特":p==="weibo"?"微博":p==="wechat"?"公众号":"RSS"}
var SCORE_GATE=55;
function passesScoreGate(e){var p=platform(feedMap[e.feedId]);if(p==="wechat")return true;var v=scoreVal(enrichments[e.id]);return v!=null&&v>=SCORE_GATE}
function visibleByCat(e){if(activeCat==="all")return true;return platform(feedMap[e.feedId])===activeCat}
function isToday(e){var d=new Date(e.publishedAt);var n=new Date();return d.toDateString()===n.toDateString()}
function countForFeed(id){return (entriesByFeed[id]||[]).length}
function icon(name){var icons={today:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2v4M16 2v4M3 10h18"/><rect x="3" y="4" width="18" height="18" rx="2"/></svg>',unread:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h6"/></svg>',star:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.3L5.8 21 7 14.2 2 9.3l6.9-1z"/></svg>',radar:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20a8 8 0 1 0-8-8"/><path d="M12 16a4 4 0 1 0-4-4"/><path d="M12 12 4 20"/></svg>'};return icons[name]||""}

var radarTopics=buildRadarTopics();
var hasSelected=allEntries.some(function(e){return selStatus(enrichments[e.id])==="selected"});
if(hasSelected)activeView="smart-selected";
else if(allEntries.some(isToday))activeView="smart-today";
else activeView="smart-unread";

function renderSmartNav(){
  var todayCount=allEntries.filter(function(e){return isToday(e)&&passesScoreGate(e)}).length;
  var selectedCount=allEntries.filter(function(e){return selStatus(enrichments[e.id])==="selected"||platform(feedMap[e.feedId])==="wechat"}).length;
  var items=[
    {id:"smart-selected",label:"\u7CBE\u9009",count:selectedCount,ico:"star"},
    {id:"smart-today",label:"\u4ECA\u5929",count:todayCount,ico:"today"},
    {id:"smart-unread",label:"\u5168\u90E8",count:allEntries.filter(passesScoreGate).length,ico:"unread"},
    {id:"smart-radar",label:"\u4ECA\u65E5\u70ED\u70B9 TOP",count:radarTopics.length,ico:"radar"}
  ];
  document.getElementById("smart-nav").innerHTML=items.map(function(it){
    return '<button class="nav-item '+(activeView===it.id?"active":"")+'" data-view="'+it.id+'"><span class="nav-ico">'+icon(it.ico)+'</span><span class="feed-name">'+it.label+'</span><span class="count">'+it.count+'</span></button>';
  }).join("");
}



function renderTabs(){
  var tabs=[["all","全部"],["xueqiu","雪球"],["weibo","微博"],["twitter","推特"],["wechat","公众号"],["other","RSS"]];
  document.getElementById("tabs").innerHTML=tabs.map(function(t){return '<button class="tab '+(activeCat===t[0]?"active":"")+'" data-cat="'+t[0]+'">'+t[1]+'</button>'}).join("");
}

function selectedEntries(){
  var list=[];
  if(activeCat!=="all"){list=allEntries.slice();if(activeCat!=="wechat")list=list.filter(passesScoreGate)}
  else if(activeView==="smart-selected")list=allEntries.filter(function(e){return selStatus(enrichments[e.id])==="selected"||platform(feedMap[e.feedId])==="wechat"});
  else if(activeView==="smart-today")list=allEntries.filter(function(e){return isToday(e)&&passesScoreGate(e)});
  else list=allEntries.filter(passesScoreGate);
  return list.filter(visibleByCat).sort(function(a,b){return new Date(b.publishedAt).getTime()-new Date(a.publishedAt).getTime()});
}

function render(){
  renderSmartNav();renderTabs();
  if(activeView==="smart-radar"){renderRadar();return}
  renderTimeline();
}

function header(title,sub){document.getElementById("header-title").textContent=title;document.getElementById("header-sub").textContent=sub||""}
function empty(msg,sub){document.getElementById("entry-list").innerHTML='<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M9 12h6"/></svg><div>'+esc(msg)+'</div>'+(sub?'<div>'+esc(sub)+'</div>':"")+'</div>'}

function renderTimeline(){
  var entries=selectedEntries();
  var title=activeView==="smart-selected"?"\u7CBE\u9009":activeView==="smart-today"?"\u4ECA\u5929":"\u5168\u90E8";
  header(title,entries.length+" \u6761\u5185\u5bb9 \u00b7 "+feeds.length+" \u4e2a\u4fe1\u6e90");
  if(!entries.length){empty("暂无内容",activeView==="smart-today"?"今天当前筛选下没有内容":"");return}
  var cl=buildClusters(entries);
  var html="";
  var lastDate="";var groupOpen=false;
  entries.slice(0,500).forEach(function(e){
    var parent=cl.memberOf[e.id];if(parent&&!expandedClusters[parent])return;
    var pd=new Date(e.publishedAt);
    var dateStr=isFinite(pd.getTime())?((pd.getMonth()+1)+"\u6708"+pd.getDate()+"\u65E5"):"";
    if(dateStr&&dateStr!==lastDate){
      if(groupOpen)html+='</div>';
      var collapsed=collapsedDates[dateStr]?"collapsed":"";
      html+='<div class="date-group '+collapsed+'" data-date-group="'+esc(dateStr)+'">';
      html+='<div class="date-header '+collapsed+'" data-toggle-date="'+esc(dateStr)+'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>'+esc(dateStr)+'<svg class="dh-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg></div>';
      lastDate=dateStr;groupOpen=true;
    }
    var hh=String(pd.getHours()).padStart(2,"0");
    var mm=String(pd.getMinutes()).padStart(2,"0");
    var card=(parent?'<div class="member">':"")+renderCard(e,cl)+(parent?"</div>":"");
    html+='<div class="tl-row"><div class="tl-time"><span class="tl-dot"></span><span class="tl-hm">'+hh+":"+mm+'</span></div><div class="tl-card">'+card+'</div></div>';
  });
  if(groupOpen)html+='</div>';
  var list=document.getElementById("entry-list");list.innerHTML=html;list.scrollTop=0;
}

function renderCard(e,cl){
  var en=enrichments[e.id]||{};var f=feedMap[e.feedId]||{};var score=scoreVal(en);
  var isOpen=activeEntryId===e.id;
  var rawDesc=strip(e.description||e.content||"").replace(/\\s+/g," ").trim();
  var titlePlain=strip(e.title||"").replace(/\\s+/g," ").trim();
  var aiSum=plain(en.summary||"").trim();
  var displayTitle;
  if(titlePlain){displayTitle=titlePlain}else{var src=f.title||"";var auth=e.author||"";if(auth&&src&&auth!==src&&src.indexOf(auth)===-1){displayTitle=src+" \u00B7 "+auth}else{displayTitle=src||auth||genTitle(rawDesc)}}
  var desc=aiSum||rawDesc.slice(0,160);
  var reason=recReason(en)||plain(en.summary||"").slice(0,120);
  var tags=Array.isArray(en.tags)?en.tags.slice(0,4):[];
  var h='<article class="card '+(isOpen?"open":"")+'" data-entry-card="'+esc(e.id)+'"><div class="card-head"><span class="feed-icon">'+(f.image?'<img src="'+esc(f.image)+'" alt="">':esc(initial(f.title||f.url)))+'</span><span class="source">'+esc(f.title||f.url||"")+'</span>';
  var sl=selLabel(en);if(sl)h+='<span class="q-wrap" tabindex="0"><span class="q q-'+scoreTier(score||0)+'">'+esc(sl)+'</span>'+qualityDetailHtml(en)+'</span>';else if(score!=null)h+='<span class="q-wrap" tabindex="0"><span class="q q-'+scoreTier(score)+'">'+score+'</span>'+qualityDetailHtml(en)+'</span>';
  h+='</div>';
  h+='<button class="card-title" data-open-entry="'+esc(e.id)+'">'+esc(displayTitle)+'</button>';
  if(desc){h+='<div class="desc">'+esc(desc)+'</div>'}
  var foot="";
  if(tags.length)foot+='<div class="tags">'+tags.map(function(t){return '<span class="tag'+tagColorClass(t)+'">'+esc(typeof t==="object"?(t.label||t.name||""):t)+'</span>'}).join("")+'</div>';
  if(cl.leaders[e.id])foot+='<button class="cluster '+(expandedClusters[e.id]?"on":"")+'" data-cluster="'+esc(e.id)+'">+'+(cl.leaders[e.id].length-1)+' 相关</button>';
  if(foot)h+='<div class="card-foot">'+foot+'</div>';
  if(reason){h+='<div class="card-reason">\u63A8\u8350\u7406\u7531\uFF1A'+esc(reason)+'</div>'}
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
  var selCount=topics.filter(function(t){return t.avgQualityScore!=null&&t.avgQualityScore>=70}).length;
  header("\u4ECA\u65E5\u70ED\u70B9 TOP",selCount+" \u7CBE\u9009 · "+topics.length+" \u4E2A\u8BDD\u9898 · \u591A\u4FE1\u6E90\u805A\u5408");
  if(!topics.length){empty("\u6682\u65E0\u70ED\u70B9\u8BDD\u9898","\u9700\u8981\u66F4\u591A\u8BA2\u9605\u5185\u5BB9\u548C AI \u5D4C\u5165\u540E\u624D\u80FD\u805A\u5408");return}
  document.getElementById("entry-list").innerHTML='<div class="radar-wrap">'+topics.map(renderTopic).join("")+'</div>';
}
function renderTopic(t){
  var open=expandedTopicId===t.id;
  var topicSel=t.avgQualityScore!=null&&t.avgQualityScore>=70?"\u7CBE\u9009":t.avgQualityScore!=null&&t.avgQualityScore>=40?"\u89C2\u5BDF":"";
  var h='<section class="radar-card '+(open?"open":"")+'"><button class="radar-main" data-topic="'+esc(t.id)+'">';
  h+='<div style="min-width:0;flex:1"><div class="radar-title-row"><span class="radar-title">'+esc(t.title)+'</span>';
  if(topicSel)h+='<span class="q q-'+(t.avgQualityScore>=70?"high":"medium")+'">'+topicSel+" "+t.avgQualityScore+'</span>';
  h+='<span class="heat"><span class="heat-dot"></span>\u540C\u4E00\u4E8B\u4EF6 \u00B7 '+t.sourceCount+' \u5BB6\u62A5\u9053</span></div>';
  h+='<div class="chips">'+t.sourceNames.slice(0,5).map(function(n){return '<span class="chip">'+esc(n.length>9?n.slice(0,9)+"...":n)+'</span>'}).join("")+(t.sourceNames.length>5?'<span class="chip">+'+(t.sourceNames.length-5)+'</span>':"")+'</div>';
  h+='<div class="meta"><span>'+shortTime(t.earliestAt)+' \u2192 '+shortTime(t.latestAt)+'</span><span>'+t.size+'\u6761</span></div></div><svg class="radar-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg></button>';
  h+='<div class="radar-entries">'+t.entryIds.slice(0,8).map(function(id){var e=allEntries.find(function(x){return x.id===id});if(!e)return"";var ren=enrichments[e.id]||{};var rsl=selLabel(ren);var f=feedMap[e.feedId]||{};return '<a class="radar-entry" href="'+esc(e.url||"#")+'" target="_blank" rel="noopener"><span class="feed-dot" style="font-size:9px">'+esc(initial(f.title||f.url))+'</span><span class="radar-entry-title">'+esc(e.title||"(\u65E0\u6807\u9898)")+'</span>'+(rsl?'<span class="q q-'+((scoreVal(ren)||0)>=70?"high":"medium")+'" style="font-size:10px">'+esc(rsl)+'</span>':"")+'<span class="time">'+when(e.publishedAt)+'</span></a>'}).join("")+'</div></section>';
  return h;
}

document.addEventListener("click",function(ev){
  var view=ev.target.closest("[data-view]");if(view){activeView=view.getAttribute("data-view");activeEntryId=null;renderDetail(null);render();closeMobile();return}
  var tab=ev.target.closest("[data-cat]");if(tab&&tab.classList.contains("tab")){activeCat=tab.getAttribute("data-cat");activeEntryId=null;renderDetail(null);render();return}
  var dateToggle=ev.target.closest("[data-toggle-date]");if(dateToggle){var dt=dateToggle.getAttribute("data-toggle-date");collapsedDates[dt]=!collapsedDates[dt];renderTimeline();return}
  var cluster=ev.target.closest("[data-cluster]");if(cluster){var cid=cluster.getAttribute("data-cluster");expandedClusters[cid]=!expandedClusters[cid];renderTimeline();return}
  var openEntry=ev.target.closest("[data-open-entry]");if(openEntry){var eid=openEntry.getAttribute("data-open-entry");showFullDetail(eid);return}
  var card=ev.target.closest("[data-entry-card]");if(card&&!ev.target.closest("a,button,.q-wrap")){var ceid=card.getAttribute("data-entry-card");showFullDetail(ceid);return}
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
function _buildPublicPageHtml(
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
<link rel="icon" href="data:image/png;base64,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VqmdfFatDSIeY80T6TRjcPtZasR83CIGs2qRbDxVmyWQWv8NzEaGDJAQTZnaJnJr/QoTalRm4H8jlW5pjFqvOgAAAohlWElmSUkqAAgAAAADAA4BAgAMAQAAMgAAADsBAgAlAAAAPgEAAGmHBAABAAAAYwEAAAAAAABTaWduYXR1cmU6IFl0ZGovaVBJVU8yRVFITkZTTTJFTUNHeVpGVXo1dnl0dnJUQlpzVytVcXp3RDYxZnpBQlowMlhmcUgwa0NITXVzQUV3dUlUcUp5SnZwME80bEU5NlA3UzVPN0I3V3d5bGRISUQxT0dMRG11V1hCdThRMkFYMDJRUjBVRUY4bURGODVJWmlJM0tHKzNSbE1zQnQ4YkZMcUZJRldCc0NuQUNJbmtDRkFycDRIZDdnUS9zNUFMd1J0dXdhSFg5K0FMUXB0K2w2MUJZTW52UEx1bTdXSWRrRENtUlB3ZzFpc3h1aHpHN2xxUlR4dFpPWkVZSy93Z25DNTFRT0grTEN6K1QAY2JhNGQ4MTMtZGU1Ni00MGIyLTgwZTQtMGE5NjYwOTY5NTVjAAEAhpIHABMBAAB1AQAAAAAAAEFTQ0lJAAAAU2lnbmF0dXJlOiBZdGRqL2lQSVVPMkVRSE5GU00yRU1DR3laRlV6NXZ5dHZyVEJac1crVXF6d0Q2MWZ6QUJaMDJYZnFIMGtDSE11c0FFd3VJVHFKeUp2cDBPNGxFOTZQN1M1TzdCN1d3eWxkSElEMU9HTERtdVdYQnU4UTJBWDAyUVIwVUVGOG1ERjg1SVppSTNLRyszUmxNc0J0OGJGTHFGSUZXQnNDbkFDSW5rQ0ZBcnA0SGQ3Z1EvczVBTHdSdHV3YUhYOStBTFFwdCtsNjFCWU1udlBMdW03V0lka0RDbVJQd2cxaXN4dWh6RzdscVJUeHRaT1pFWUsvd2duQzUxUU9IK0xDeitUh1hm3QAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNi0yNFQxODozOTo0MSswMDowMGN6kb8AAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDYtMjRUMTg6Mzk6NDErMDA6MDASJykDAAAAMHRFWHRleGlmOkFydGlzdABjYmE0ZDgxMy1kZTU2LTQwYjItODBlNC0wYTk2NjA5Njk1NWMfaem6AAAAE3RFWHRleGlmOkV4aWZPZmZzZXQAMzU1k9WcLwAAAQV6VFh0ZXhpZjpJbWFnZURlc2NyaXB0aW9uAAAYlQXBR3KDMAAAwK/kzoFiU5ybJCQkG0Ifys0ZYkIoQ5GQ4fXZTbt2enKx/nx+VLz5U7uI5aGBY/pF0sDAAfKOmuSnuR98XzNYb4WSL6d0Lf11AlhrRvlaqNYjGogNYClYttyP+z5r4XXANyuyUzO0oV3IY2goc/XQ891RFCUUTmyAUjPiRMsxcUaXOCarO3Z5eMolGYINcueb+AthpIAbmgBiU48IWOcrbew2VjcT+DLhQj5peVOAH89cGSwdVsG0R74Y7YI1vYvGJJKt3m1v8Xt69rAk2ZvXYY2rhyrbCZl6HFLFR6eS/QO2AFcZRjwO/AAAAap6VFh0ZXhpZjpVc2VyQ29tbWVudAAAOI1NU9uRxDAIa2ULyIed8HL/jR0CkdzMJuvYRkgCTK9fPNfP/Pr508+aHw72Uryw2rl1HAvDq1aCw339NK7fc2fImfO18MqVOFFiNX7k2vOe5rflf2S8Z6wnhjOt+3eOdfHLe/vO11m8CGp3RmrRCx6TX5Bf5GPWUXuDR2IJeez9EGPvTGUZpHlfIGPdPDL9ECSaWMTcAALoS+0M17t50yYlyGGe2i4vZBCE7GvR5AlaXiHTioZQb5YwVFlAWFAXyVUptNOVLStYliL3tFooRRzMdeu9vYYiEKDUpuJqXa+qjfbha0nuBzkH1aJMaoS0+DaUzVZVQXfgQ0FCm4zwO0a5v04aawycQ0y3MZJdVg3ic1u7LNXDpl+/18ZXNZ52X8N/+O43fdMZBSiVoQMlCGoGh4z/zcjpsQEM7FK238TEZq6KkYdypw3BP87IX2yOeCU7zZ2Cl6r1qgoKXyQWa3oCQrrPlUr2vV5EYe+jFK07aHChyHubc4EeOjPQp8so/j9Xe+9tmMzcHw7Pw/Zz5q0BlT/UI9Kfa9putwAAAABJRU5ErkJggg==" type="image/png">
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
  font-family:system-ui,"SN Pro","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;
  background:hsl(var(--background));
  color:color-mix(in srgb, rgba(var(--color-text)) 100%, transparent);
  line-height:1.56;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  font-feature-settings:"cv02","cv03","cv04","cv11";
}
a{color:inherit;text-decoration:none}

/* ── Layout: sidebar + main (matches MainDesktopLayout) ── */
.app{display:flex;height:100vh;overflow:hidden}

/* ── Sidebar (matches SubscriptionColumnContainer) ── */
.sidebar{width:256px;flex-shrink:0;background:hsl(var(--fo-sidebar));border-right:1px solid hsl(var(--border));display:flex;flex-direction:column;overflow:hidden}
.logo{padding:20px 16px 12px;display:flex;align-items:center;gap:8px}
.logo-text{font-size:17px;font-weight:760;letter-spacing:-0.02em;color:hsl(var(--fo-a))}
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
.nav-divider{height:1px;margin:8px 12px;background:linear-gradient(to right,transparent,color-mix(in srgb, rgba(var(--color-fillSecondary)) 100%, transparent),transparent)}
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
.header-title{font-size:16px;font-weight:720;letter-spacing:-0.01em}
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
.date-header{padding:20px 8px 8px;font-size:13px;font-weight:650;color:color-mix(in srgb, rgba(var(--color-textSecondary)) 100%, transparent);letter-spacing:.02em;display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;transition:color .18s}.date-header:hover{color:rgba(var(--color-text))}.date-header svg{width:15px;height:15px;opacity:.5;flex-shrink:0}.date-header .dh-arrow{width:12px;height:12px;margin-left:2px;transition:transform .25s ease;opacity:.4}.date-header.collapsed .dh-arrow{transform:rotate(-90deg)}.date-group.collapsed .tl-row{display:none}
.tl-row{display:flex;align-items:flex-start;gap:0}
.tl-time{flex:0 0 56px;display:flex;flex-direction:row;align-items:center;justify-content:flex-end;gap:5px;padding-top:18px;padding-right:8px;font-variant-numeric:tabular-nums}
.tl-dot{width:6px;height:6px;border-radius:50%;background:#34d399;flex-shrink:0}
.tl-hm{white-space:nowrap;font-weight:600;font-size:12.5px;color:color-mix(in srgb, rgba(var(--color-textSecondary)) 100%, transparent);letter-spacing:0;font-feature-settings:'tnum'}
.tl-card{flex:1;min-width:0}

/* ── Entry card (exact match to list-item-template.tsx) ── */
/* mx-2 my-1.5 rounded-xl border border-border/60 bg-fill-quaternary/50 px-4 py-3 */
.card{
  position:relative;
  margin:6px 8px;
  padding:14px 16px;
  border:1px solid rgba(15,23,42,.08);
  border-left:2.5px solid hsl(var(--fo-a) / .35);
  border-radius:16px;
  background:hsl(var(--background));
  transition:border-color .22s ease,background .22s ease,box-shadow .28s ease,transform .22s ease;
  overflow:hidden;
}
.card::after{content:'';position:absolute;inset:0;opacity:0;background:linear-gradient(105deg,transparent 40%,rgba(255,255,255,.5) 45%,rgba(255,255,255,.8) 50%,rgba(255,255,255,.5) 55%,transparent 60%);transition:opacity .3s ease;pointer-events:none}
.card:hover{border-color:hsl(var(--fo-a) / .55);background:linear-gradient(135deg,hsl(var(--background)) 0%,color-mix(in srgb,hsl(var(--background)) 96%,#dbeafe) 50%,hsl(var(--background)) 100%);box-shadow:0 1px 3px rgba(15,23,42,.05),0 8px 24px rgba(15,23,42,.08),0 0 0 1px hsl(var(--fo-a) / .08);transform:translateY(-2px) scale(1.003)}
.card:hover::after{opacity:1;animation:cardShine .6s ease forwards}
.card:active{transform:translateY(0) scale(1);transition-duration:.1s}
@keyframes cardShine{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
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
/* Apple-gray selected score badge */
.q-high{background:color-mix(in srgb, rgba(var(--color-fillTertiary)) 100%, transparent);color:color-mix(in srgb, rgba(var(--color-textSecondary)) 100%, transparent);border:1px solid color-mix(in srgb, rgba(var(--color-fillSecondary)) 100%, transparent)}
/* Apple-gray quality score badge */
.q-medium{background:color-mix(in srgb, rgba(var(--color-fillTertiary)) 100%, transparent);color:color-mix(in srgb, rgba(var(--color-textSecondary)) 100%, transparent);border:1px solid color-mix(in srgb, rgba(var(--color-fillSecondary)) 100%, transparent)}
/* bg-gray/15 text-text-secondary border border-gray/15 */
.q-low{background:rgb(var(--color-gray) / 0.15);color:color-mix(in srgb, rgba(var(--color-textSecondary)) 100%, transparent);border:1px solid rgb(var(--color-gray) / 0.15)}
/* bg-gray/10 text-text-tertiary border border-gray/10 */
.q-ignore{background:rgb(var(--color-gray) / 0.1);color:color-mix(in srgb, rgba(var(--color-textTertiary)) 100%, transparent);border:1px solid rgb(var(--color-gray) / 0.1)}

/* ── Title (mt-1.5 text-[15px] font-bold leading-snug text-text) ── */
.card-title{display:block;margin-top:6px;font-size:15.5px;font-weight:640;line-height:1.48;
  letter-spacing:-0.01em;
  color:color-mix(in srgb, rgba(var(--color-text)) 100%, transparent);
  word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card-title:hover{color:hsl(var(--fo-a))}

/* ── Description (truncated, deduplicated from title) ── */
.card-desc{margin-top:12px;font-size:13.5px;line-height:1.65;font-weight:400;letter-spacing:.005em;
  color:color-mix(in srgb, rgba(var(--color-textSecondary)) 100%, transparent);
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
/* ── Recommendation reason (Apple-style neutral block) ── */
.card-reason{margin-top:10px;padding:9px 12px;border:0;border-left:2px solid hsl(var(--fo-a) / .2);border-radius:0 8px 8px 0;
  background:color-mix(in srgb, rgba(var(--color-fillQuaternary)) 100%, transparent);
  color:color-mix(in srgb, rgba(var(--color-textSecondary)) 100%, transparent);font-size:12.5px;font-weight:480;line-height:1.58;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}

/* ── Footer: tags + cluster (mt-1.5 flex items-center gap-2) ── */
.card-footer{display:flex;align-items:center;gap:8px;margin-top:6px}
.card-tags{display:flex;flex-wrap:wrap;gap:4px;flex:1;min-width:0;margin:2px 0}
/* Tag chips (rounded bg-fill-secondary px-1.5 py-0.5 text-[11px] text-text-secondary) */
.tag{font-size:11px;padding:2px 7px;border-radius:4px;
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

/* ── Full-page detail ── */
.fp-detail{display:none;position:fixed;inset:0;z-index:100;background:hsl(var(--background));overflow-y:auto;scrollbar-width:thin}
.fp-detail.open{display:block}
.fp-back{display:inline-flex;align-items:center;gap:6px;padding:14px 24px;font-size:14px;font-weight:600;color:hsl(var(--fo-a));cursor:pointer;border:0;background:transparent;position:sticky;top:0;z-index:10;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);background:hsl(var(--background) / .85)}
.fp-back:hover{opacity:.8}
.fp-back svg{width:18px;height:18px}
.fp-inner{max-width:720px;margin:0 auto;padding:0 24px 48px}
.fp-source{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.fp-source-icon{width:24px;height:24px;border-radius:8px;background:color-mix(in srgb,rgba(var(--color-fillSecondary)) 100%,transparent);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:color-mix(in srgb,rgba(var(--color-textTertiary)) 100%,transparent);overflow:hidden}
.fp-source-icon img{width:100%;height:100%;object-fit:cover}
.fp-source-name{font-size:14px;font-weight:650;color:color-mix(in srgb,rgba(var(--color-text)) 100%,transparent)}
.fp-source-plat{font-size:12px;color:color-mix(in srgb,rgba(var(--color-textTertiary)) 100%,transparent);padding:2px 8px;border-radius:4px;background:color-mix(in srgb,rgba(var(--color-fillSecondary)) 100%,transparent)}
.fp-badges{display:flex;gap:6px;margin-bottom:14px}
.fp-title{font-size:24px;font-weight:780;line-height:1.34;color:color-mix(in srgb,rgba(var(--color-text)) 100%,transparent);letter-spacing:-.02em;word-break:break-word;margin-bottom:10px}
.fp-date{font-size:13px;color:color-mix(in srgb,rgba(var(--color-textTertiary)) 100%,transparent);margin-bottom:24px;display:flex;align-items:center;gap:6px}
.fp-date svg{width:14px;height:14px;opacity:.5}
.fp-section{margin-top:24px;border-radius:12px;border:1px solid color-mix(in srgb,rgba(var(--color-fillTertiary)) 100%,transparent);overflow:hidden}
.fp-section-head{display:flex;align-items:center;gap:8px;padding:14px 18px;font-size:13px;font-weight:700;color:hsl(var(--fo-a));border-bottom:1px solid color-mix(in srgb,rgba(var(--color-fillTertiary)) 100%,transparent);background:linear-gradient(135deg,hsl(var(--fo-a) / .04),transparent 60%)}
.fp-section-head svg{width:16px;height:16px;flex-shrink:0}
.fp-section-body{padding:16px 18px;font-size:15px;line-height:1.78;color:color-mix(in srgb,rgba(var(--color-text)) 100%,transparent);white-space:pre-wrap;word-break:break-word}
.fp-reason{margin-top:24px;border-radius:12px;border-left:3px solid #34d399;background:rgba(52,211,153,.06);padding:16px 18px}
.fp-reason-head{font-size:13px;font-weight:700;color:#047857;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.fp-reason-head svg{width:15px;height:15px}
.fp-reason-body{font-size:15px;line-height:1.72;color:color-mix(in srgb,rgba(var(--color-text)) 100%,transparent)}
.fp-toggle{display:inline-flex;align-items:center;gap:4px;margin-top:8px;padding:6px 12px;border-radius:8px;border:1px solid color-mix(in srgb,rgba(var(--color-fillTertiary)) 100%,transparent);background:transparent;color:hsl(var(--fo-a));font-size:12.5px;font-weight:600;cursor:pointer;transition:background .18s}
.fp-toggle:hover{background:hsl(var(--fo-a) / .06)}
.fp-orig-link{display:inline-flex;align-items:center;gap:5px;margin-top:20px;padding:10px 16px;border-radius:10px;background:hsl(var(--fo-a) / .08);color:hsl(var(--fo-a));font-size:13px;font-weight:620;text-decoration:none;border:1px solid hsl(var(--fo-a) / .16)}.fp-orig-link:hover{background:hsl(var(--fo-a) / .14)}
.fp-article{font-size:16.5px;line-height:1.85;color:color-mix(in srgb,rgba(var(--color-text)) 100%,transparent);word-break:break-word;-webkit-font-smoothing:antialiased;white-space:normal}
.fp-article p{margin:0 0 16px;font-weight:400}
.fp-article p:last-child{margin-bottom:0}
.fp-article h3{font-size:19px;font-weight:700;margin:36px 0 14px;padding-top:24px;border-top:1px solid color-mix(in srgb,rgba(var(--color-fillTertiary)) 100%,transparent);color:color-mix(in srgb,rgba(var(--color-text)) 100%,transparent);letter-spacing:-.01em;line-height:1.35}
.fp-article h3:first-child{margin-top:0;padding-top:0;border-top:0}
.fp-article h4{font-size:16.5px;font-weight:700;margin:24px 0 10px;color:color-mix(in srgb,rgba(var(--color-text)) 100%,transparent);line-height:1.35}
.fp-article strong{background:linear-gradient(180deg,transparent 62%,color-mix(in srgb,rgba(var(--color-fillSecondary)) 100%,transparent) 62%);color:color-mix(in srgb,rgba(var(--color-text)) 100%,transparent);font-weight:700;padding:0 2px;font-variant-numeric:tabular-nums}
.fp-article em{font-style:italic;color:color-mix(in srgb,rgba(var(--color-textSecondary)) 100%,transparent)}
.fp-article ul,.fp-article ol{margin:10px 0 16px;padding-left:24px}
.fp-article li{margin-bottom:6px;font-size:16px;line-height:1.75}
.fp-article li strong{background:linear-gradient(180deg,transparent 62%,color-mix(in srgb,rgba(var(--color-fillSecondary)) 100%,transparent) 62%)}
.fp-article blockquote{background:color-mix(in srgb,rgba(var(--color-fillQuaternary)) 100%,transparent);border-left:4px solid hsl(var(--fo-a));border-radius:8px;color:color-mix(in srgb,rgba(var(--color-text)) 100%,transparent);margin:20px 0;padding:14px 18px;font-size:15.5px;line-height:1.75}
.fp-article hr{background:color-mix(in srgb,rgba(var(--color-fillTertiary)) 100%,transparent);border:0;height:1px;margin:36px 0}
.fp-article .art-highlight{background:linear-gradient(180deg,transparent 40%,hsl(var(--fo-a) / .12) 40%);padding:0 3px;border-radius:2px;font-weight:600}
.fp-article .art-tag{display:inline-block;background:color-mix(in srgb,rgba(var(--color-fillSecondary)) 100%,transparent);color:color-mix(in srgb,rgba(var(--color-textSecondary)) 100%,transparent);font-size:13px;padding:2px 8px;border-radius:6px;margin:2px 3px 2px 0;font-weight:500}
.fp-article .art-sep{display:block;text-align:center;color:color-mix(in srgb,rgba(var(--color-textTertiary)) 100%,transparent);font-size:13px;margin:28px 0;letter-spacing:.3em}
.fp-article a{color:hsl(var(--fo-a));border-bottom:1px solid hsl(var(--fo-a) / .32);font-weight:500;text-decoration:none;transition:border-color .18s}
.fp-article a:hover{border-bottom-color:hsl(var(--fo-a))}

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
  .tl-time{flex:0 0 48px;padding-top:16px;gap:4px;padding-right:6px}
  .tl-hm{font-size:11px}
  .card{margin:4px;padding:10px 12px}
  .fp-inner{padding:0 12px 32px}.fp-title{font-size:18px}.fp-back{padding:12px 16px;font-size:13px}.fp-section-body{font-size:14px;padding:12px 14px}.fp-reason{padding:12px 14px}.fp-article{font-size:15px}.fp-article h3{font-size:17px}.fp-article li{font-size:14.5px}
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
<div style="display:flex;align-items:center;gap:8px">
<img src="data:image/png;base64,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SkbLLxK0EcMyiERNtCe1p2hCuxVVjV9baoGtAlIQMZjB/w/a0QpLdsTkagAAAohlWElmSUkqAAgAAAADAA4BAgAMAQAAMgAAADsBAgAlAAAAPgEAAGmHBAABAAAAYwEAAAAAAABTaWduYXR1cmU6IFl0ZGovaVBJVU8yRVFITkZTTTJFTUNHeVpGVXo1dnl0dnJUQlpzVytVcXp3RDYxZnpBQlowMlhmcUgwa0NITXVzQUV3dUlUcUp5SnZwME80bEU5NlA3UzVPN0I3V3d5bGRISUQxT0dMRG11V1hCdThRMkFYMDJRUjBVRUY4bURGODVJWmlJM0tHKzNSbE1zQnQ4YkZMcUZJRldCc0NuQUNJbmtDRkFycDRIZDdnUS9zNUFMd1J0dXdhSFg5K0FMUXB0K2w2MUJZTW52UEx1bTdXSWRrRENtUlB3ZzFpc3h1aHpHN2xxUlR4dFpPWkVZSy93Z25DNTFRT0grTEN6K1QAY2JhNGQ4MTMtZGU1Ni00MGIyLTgwZTQtMGE5NjYwOTY5NTVjAAEAhpIHABMBAAB1AQAAAAAAAEFTQ0lJAAAAU2lnbmF0dXJlOiBZdGRqL2lQSVVPMkVRSE5GU00yRU1DR3laRlV6NXZ5dHZyVEJac1crVXF6d0Q2MWZ6QUJaMDJYZnFIMGtDSE11c0FFd3VJVHFKeUp2cDBPNGxFOTZQN1M1TzdCN1d3eWxkSElEMU9HTERtdVdYQnU4UTJBWDAyUVIwVUVGOG1ERjg1SVppSTNLRyszUmxNc0J0OGJGTHFGSUZXQnNDbkFDSW5rQ0ZBcnA0SGQ3Z1EvczVBTHdSdHV3YUhYOStBTFFwdCtsNjFCWU1udlBMdW03V0lka0RDbVJQd2cxaXN4dWh6RzdscVJUeHRaT1pFWUsvd2duQzUxUU9IK0xDeitUh1hm3QAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNi0yNFQxODozOTo0MSswMDowMGN6kb8AAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDYtMjRUMTg6Mzk6NDErMDA6MDASJykDAAAAMHRFWHRleGlmOkFydGlzdABjYmE0ZDgxMy1kZTU2LTQwYjItODBlNC0wYTk2NjA5Njk1NWMfaem6AAAAE3RFWHRleGlmOkV4aWZPZmZzZXQAMzU1k9WcLwAAAQV6VFh0ZXhpZjpJbWFnZURlc2NyaXB0aW9uAAAYlQXBR3KDMAAAwK/kzoFiU5ybJCQkG0Ifys0ZYkIoQ5GQ4fXZTbt2enKx/nx+VLz5U7uI5aGBY/pF0sDAAfKOmuSnuR98XzNYb4WSL6d0Lf11AlhrRvlaqNYjGogNYClYttyP+z5r4XXANyuyUzO0oV3IY2goc/XQ891RFCUUTmyAUjPiRMsxcUaXOCarO3Z5eMolGYINcueb+AthpIAbmgBiU48IWOcrbew2VjcT+DLhQj5peVOAH89cGSwdVsG0R74Y7YI1vYvGJJKt3m1v8Xt69rAk2ZvXYY2rhyrbCZl6HFLFR6eS/QO2AFcZRjwO/AAAAap6VFh0ZXhpZjpVc2VyQ29tbWVudAAAOI1NU9uRxDAIa2ULyIed8HL/jR0CkdzMJuvYRkgCTK9fPNfP/Pr508+aHw72Uryw2rl1HAvDq1aCw339NK7fc2fImfO18MqVOFFiNX7k2vOe5rflf2S8Z6wnhjOt+3eOdfHLe/vO11m8CGp3RmrRCx6TX5Bf5GPWUXuDR2IJeez9EGPvTGUZpHlfIGPdPDL9ECSaWMTcAALoS+0M17t50yYlyGGe2i4vZBCE7GvR5AlaXiHTioZQb5YwVFlAWFAXyVUptNOVLStYliL3tFooRRzMdeu9vYYiEKDUpuJqXa+qjfbha0nuBzkH1aJMaoS0+DaUzVZVQXfgQ0FCm4zwO0a5v04aawycQ0y3MZJdVg3ic1u7LNXDpl+/18ZXNZ52X8N/+O43fdMZBSiVoQMlCGoGh4z/zcjpsQEM7FK238TEZq6KkYdypw3BP87IX2yOeCU7zZ2Cl6r1qgoKXyQWa3oCQrrPlUr2vV5EYe+jFK07aHChyHubc4EeOjPQp8so/j9Xe+9tmMzcHw7Pw/Zz5q0BlT/UI9Kfa9putwAAAABJRU5ErkJggg==" alt="FinHot" style="width:26px;height:26px;border-radius:7px">
<div>
<div class="logo-text">FinHot</div>
<div class="logo-sub">金融动态聚合</div>
</div>
</div>
</div>
<nav class="nav">
<div class="nav-section">内容</div>
<button class="nav-item active" data-id="__all__">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
<span class="feed-name">全部动态</span>
</button>
</nav>
<div class="nav-divider"></div>
<nav class="nav">
<div class="nav-section">更多</div>
<button class="nav-item" data-id="about">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
<span class="feed-name">关于</span>
</button>
<button class="nav-item" data-id="feedback">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
<span class="feed-name">反馈</span>
</button>
</nav>
<div class="sidebar-footer">
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
<div class="fp-detail" id="fp-detail"></div>
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
function stripNL(s){if(!s)return"";var h=String(s);h=h.replace(/<br\\s*\\/?>/gi,"\\n");h=h.replace(/<\\/(p|div|li|h[1-6]|blockquote|tr)>/gi,"\\n");h=h.replace(/<img[^>]*>/gi,"");var d=document.createElement("div");d.innerHTML=h;return d.textContent||""}
function genTitle(text){if(!text)return"(\u65E0\u6807\u9898)";var s=text.replace(/\\s+/g," ").trim();var m=s.match(/^[^\u3002\uFF01\uFF1F!?.]+[\u3002\uFF01\uFF1F!?.]?/);var t=m?m[0]:s.slice(0,50);if(t.length>50)t=t.slice(0,50);return t+(t.length<s.length?"\u2026":"")||"(\u65E0\u6807\u9898)"}
function genAiTitle(s){if(!s)return"";s=s.replace(/\\s+/g," ").trim();var m=s.match(/^[^\u3002\uFF01\uFF1F!?.\\n]+/);var t=m?m[0].trim():s.slice(0,50);if(t.length>50)t=t.slice(0,50)+"\u2026";return t||""}
function normalizeSummary(s){if(!s)return"";return s.replace(/\`\`\`[\\s\\S]*?\`\`\`/g," ").replace(/\`([^\`]+)\`/g,"$1").replace(/\\*\\*([^*]+)\\*\\*/g,"$1").replace(/\\*([^*]+)\\*/g,"$1").replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g,"$1").replace(/^\\s{0,3}#{1,6}\\s+/gm,"").replace(/^\\s*[-*+]\\s+/gm,"").replace(/\\s+/g," ").trim()}
function timeAgo(d){var diff=Date.now()-new Date(d).getTime();var m=Math.floor(diff/60000);if(m<1)return"刚刚";if(m<60)return m+"分钟前";var h=Math.floor(m/60);if(h<24)return h+"小时前";var days=Math.floor(h/24);if(days<30)return days+"天前";return new Date(d).toLocaleDateString("zh-CN")}
function scoreTier(s){return s>=70?"high":s>=40?"medium":s>=20?"low":"ignore"}
function feedInitial(title){if(!title)return"?";var c=title.charAt(0);return /[\\u4e00-\\u9fff]/.test(c)?c:c.toUpperCase()}
function articleHtml(s){if(!s)return"";var t=esc(String(s).trim()).replace(/\\n{3,}/g,"\\n\\n");t=t.replace(/([^\\n])([\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341]+\\u3001)/g,"$1\\n$2");t=t.replace(/([^\\n\\u3001])(\\d+\\u3001)/g,"$1\\n$2");t=t.replace(/([^\\n])(No\\.\\d+)/gi,"$1\\n$2");var lines=t.split(/\\n/);var out="";var ul=0;for(var i=0;i<lines.length;i++){var ln=lines[i].trim();if(!ln){if(ul){out+="</ul>";ul=0}continue}if(/^[\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341]+[\\u3001.]/.test(ln)){if(ul){out+="</ul>";ul=0}out+="<h3>"+artHL(ln)+"</h3>";continue}if(/^[\\uff08(][\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341]+[\\uff09)]/.test(ln)){if(ul){out+="</ul>";ul=0}out+="<h4>"+artHL(ln)+"</h4>";continue}if(/^No\\.\\d+$/i.test(ln)){if(ul){out+="</ul>";ul=0}out+='<span class="art-sep">'+ln+'</span>';continue}if(/^\\d{1,2}\\u3001/.test(ln)){if(!ul){out+="<ul>";ul=1}out+="<li>"+artHL(ln.replace(/^\\d{1,2}\\u3001\\s*/,""))+"</li>";continue}if(/^[\\xb7\\u2022\\-]\\s/.test(ln)){if(!ul){out+="<ul>";ul=1}out+="<li>"+artHL(ln.replace(/^[\\xb7\\u2022\\-]\\s+/,""))+"</li>";continue}if(ul){out+="</ul>";ul=0}out+="<p>"+artHL(ln)+"</p>"}if(ul)out+="</ul>";return out}
function artHL(s){return s.replace(/\\u300a([^\\u300b]+)\\u300b/g,"<strong>\\u300a$1\\u300b</strong>").replace(/\\u3010([^\\u3011]+)\\u3011/g,"<strong>\\u3010$1\\u3011</strong>")}

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
    if(/:8090/i.test(feedUrl)||/wechat|mp\\.weixin/i.test(feedUrl))return"wechat";
    if(/xueqiu/i.test(feedUrl))return"xueqiu";
    if(/twitter|nitter|xcancel|\\/x\\.com\\//i.test(feedUrl))return"twitter";
    if(/weibo/i.test(feedUrl))return"weibo";
  }
  if(cat==="雪球")return"xueqiu";if(cat==="推特")return"twitter";if(cat==="微博")return"weibo";if(cat==="公众号")return"wechat";
  return"other";
}
var SCORE_GATE_SV=55;
function passesScoreGateSV(e){var f=feedMap[e.feedId];if(!f)return false;var p=getPlatform(f.url,f.category);if(p==="wechat")return true;var en=enrichments[e.id];var qs=en&&en.qualityScore;return qs!=null&&qs>=SCORE_GATE_SV}

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
function renderFeeds(){}

// ── Cosine similarity & clustering ──
function cosSim(a,b){if(!a||!b||a.length!==b.length)return 0;var dot=0,na=0,nb=0;for(var i=0;i<a.length;i++){dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i]}return na&&nb?dot/Math.sqrt(na*nb):0}
var expandedClusters={};
var collapsedDates={};
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
  var rawDescFull=strip(e.description||e.content||"").slice(0,200);
  var titlePlain=strip(e.title||"").replace(/\\s+/g," ").trim();
  var aiSumSV=normalizeSummary(en.summary||"").trim();
  var displayTitle;
  if(titlePlain){displayTitle=titlePlain}else{var srcSV=feedTitle||"";var authSV=e.author||"";if(authSV&&srcSV&&authSV!==srcSV&&srcSV.indexOf(authSV)===-1){displayTitle=srcSV+" \u00B7 "+authSV}else{displayTitle=srcSV||authSV||genTitle(rawDescFull)}}
  var desc=aiSumSV||rawDescFull.slice(0,160);
  var reason=en.recommendationReason||en.recommendation_reason||(en.summary?normalizeSummary(en.summary).slice(0,120):"");

  var h='<div class="card unread" data-entry-card="'+esc(e.id)+'">';

  h+='<div class="card-header">';
  h+='<div class="card-feed-icon"><span>'+esc(feedInitial(feedTitle))+'</span></div>';
  h+='<span class="card-feed-name">'+esc(feedTitle)+'</span>';
  if(en.qualityScore!=null){h+='<span class="q-score q-'+scoreTier(en.qualityScore)+'">'+en.qualityScore+'</span>'}
  h+='</div>';

  h+='<a class="card-title" href="'+(e.url||"#")+'" target="_blank" rel="noopener">'+esc(displayTitle)+'</a>';

  if(desc){
    h+='<div class="card-desc">'+esc(desc)+'</div>';
  }

  // Footer: tags + cluster badge
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

  if(reason){h+='<div class="card-reason">\u63A8\u8350\u7406\u7531\uFF1A'+esc(reason)+'</div>'}

  h+='</div>';
  return h;
}

// ── Render entry list ──
function renderTimeline(){
  var entries=allEntries;
  if(activeCat!=="all"){
    entries=entries.filter(function(e){
      var f=feedMap[e.feedId];if(!f)return false;
      return getPlatform(f.url,f.category)===activeCat;
    });
  }
  entries=entries.filter(function(e){return passesScoreGateSV(e)});
  document.getElementById("header-title").textContent="\u5168\u90E8\u52A8\u6001";
  document.getElementById("header-sub").textContent=entries.length+" \u6761\u5185\u5BB9 \u00B7 "+feeds.length+" \u4E2A\u4FE1\u6E90";
  if(!entries.length){document.getElementById("entry-list").innerHTML='<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg><div>暂无内容</div></div>';return}

  var cl=buildClusters(entries);
  var html="";
  var lastDateSV="";var groupOpenSV=false;
  entries.forEach(function(e){
    if(cl.memberOf[e.id]&&!expandedClusters[cl.memberOf[e.id]])return;
    var isClusterMember=!!cl.memberOf[e.id];
    var pdSV=new Date(e.publishedAt);
    var dateSV=isFinite(pdSV.getTime())?((pdSV.getMonth()+1)+"\u6708"+pdSV.getDate()+"\u65E5"):"";
    if(dateSV&&dateSV!==lastDateSV){
      if(groupOpenSV)html+='</div>';
      var collapsedSV=collapsedDates[dateSV]?"collapsed":"";
      html+='<div class="date-group '+collapsedSV+'" data-date-group="'+esc(dateSV)+'">';
      html+='<div class="date-header '+collapsedSV+'" data-toggle-date="'+esc(dateSV)+'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>'+esc(dateSV)+'<svg class="dh-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg></div>';
      lastDateSV=dateSV;groupOpenSV=true;
    }
    var hhSV=String(pdSV.getHours()).padStart(2,"0");
    var mmSV=String(pdSV.getMinutes()).padStart(2,"0");
    var card=(isClusterMember?'<div class="cluster-member">':'')+renderCard(e,cl)+(isClusterMember?'</div>':'');
    html+='<div class="tl-row"><div class="tl-time"><span class="tl-dot"></span><span class="tl-hm">'+hhSV+":"+mmSV+'</span></div><div class="tl-card">'+card+'</div></div>';
  });
  if(groupOpenSV)html+='</div>';
  document.getElementById("entry-list").innerHTML=html;
  document.getElementById("entry-list").scrollTop=0;
}

// ── Full-page detail ──
function showFullDetail(entryId){
  var fp=document.getElementById("fp-detail");
  if(!entryId){fp.classList.remove("open");fp.innerHTML="";return}
  var e=allEntries.find(function(x){return x.id===entryId});
  if(!e){fp.classList.remove("open");fp.innerHTML="";return}
  var en=enrichments[e.id]||{};var f=feedMap[e.feedId]||{};
  var p=getPlatform(f.url,f.category);
  var PLAT_LABELS={xueqiu:"\u96EA\u7403",weibo:"\u5FAE\u535A",twitter:"\u63A8\u7279",wechat:"\u516C\u4F17\u53F7",other:"RSS"};
  var pLabel=PLAT_LABELS[p]||"RSS";
  var summary=normalizeSummary(en.summary||"").trim();
  var reason=en.recommendationReason||en.recommendation_reason||"";
  var tr=en.translation||{};
  var translatedBody=tr.readabilityContent||tr.content||tr.description||"";
  var hasTransl=!!translatedBody||!!(tr.title||tr.description);
  var score=en.qualityScore;
  var bodyText=stripNL(e.content||e.description||"").replace(/[ \\t\\r]+/g," ").trim();
  var titleText=strip(e.title||"").replace(/\\s+/g," ").trim();
  if(!titleText){var _src2=feedTitle||"";var _auth2=e.author||"";if(_auth2&&_src2&&_auth2!==_src2&&_src2.indexOf(_auth2)===-1){titleText=_src2+" \u00B7 "+_auth2}else{titleText=_src2||_auth2||"(\u65E0\u6807\u9898)"}}
  var pd=new Date(e.publishedAt);
  var dateStr=isFinite(pd.getTime())?(pd.getFullYear()+"\u5E74"+(pd.getMonth()+1)+"\u6708"+pd.getDate()+"\u65E5 "+String(pd.getHours()).padStart(2,"0")+":"+String(pd.getMinutes()).padStart(2,"0")):"";
  var h='<button class="fp-back" id="fp-back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>\u8FD4\u56DE</button>';
  h+='<div class="fp-inner">';
  h+='<div class="fp-source"><span class="fp-source-icon">'+esc(feedInitial(f.title||f.url))+'</span><span class="fp-source-name">'+esc(f.title||f.url||'')+'</span><span class="fp-source-plat">'+esc(pLabel)+'</span></div>';
  if(score!=null){h+='<div class="fp-badges"><span class="q-score q-'+scoreTier(score)+'">'+score+'</span></div>'}
  h+='<h1 class="fp-title">'+esc(titleText)+'</h1>';
  h+='<div class="fp-date"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>'+esc(dateStr)+(dateStr?" \u00B7 ":"")+esc(timeAgo(e.publishedAt))+'</div>';
  if(reason){h+='<div class="fp-reason"><div class="fp-reason-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.7 5.8 21 7 14.2 2 9.3l6.9-1z"/></svg>\u7CBE\u9009\u7406\u7531</div><div class="fp-reason-body">'+esc(reason)+'</div></div>'}
  if(summary){h+='<div class="fp-section"><div class="fp-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z"/></svg>AI \u6458\u8981</div><div class="fp-section-body">'+esc(summary)+'</div></div>'}
  if(hasTransl){
    h+='<div class="fp-section"><div class="fp-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>AI \u7FFB\u8BD1 \u00B7 \u4E2D\u6587</div><div class="fp-section-body" id="fp-trans-body">';
    if(tr.title)h+='<div style="font-weight:660;margin-bottom:8px">'+esc(tr.title)+'</div>';
    if(translatedBody)h+=esc(translatedBody);
    h+='</div></div>';
    if(bodyText){h+='<button class="fp-toggle" id="fp-toggle-orig">\u663E\u793A\u539F\u6587</button><div class="fp-section" id="fp-orig-section" style="display:none"><div class="fp-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>\u539F\u6587</div><div class="fp-section-body fp-article">'+articleHtml(bodyText)+'</div></div>'}
  } else if(bodyText){
    h+='<div class="fp-section"><div class="fp-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>\u539F\u6587</div><div class="fp-section-body fp-article">'+articleHtml(bodyText)+'</div></div>';
  }
  if(e.url){h+='<a class="fp-orig-link" href="'+esc(e.url)+'" target="_blank" rel="noopener">\u6253\u5F00\u539F\u6587 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg></a>'}
  h+='</div>';
  fp.innerHTML=h;fp.scrollTop=0;fp.classList.add("open");
  document.getElementById("fp-back").addEventListener("click",function(){showFullDetail(null)});
  var togBtn=document.getElementById("fp-toggle-orig");
  if(togBtn){togBtn.addEventListener("click",function(){var sec=document.getElementById("fp-orig-section");if(!sec)return;var vis=sec.style.display!=="none";sec.style.display=vis?"none":"block";togBtn.textContent=vis?"\u663E\u793A\u539F\u6587":"\u9690\u85CF\u539F\u6587"})}
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
    renderTimeline();
    if(window.innerWidth<=768){document.getElementById("sidebar").classList.remove("open");document.getElementById("overlay").classList.remove("open")}
    return;
  }
  var dateToggle=ev.target.closest("[data-toggle-date]");
  if(dateToggle){var dt=dateToggle.getAttribute("data-toggle-date");collapsedDates[dt]=!collapsedDates[dt];renderTimeline();return}
  var clBtn=ev.target.closest(".cluster-badge");
  if(clBtn){var cid=clBtn.getAttribute("data-cluster");expandedClusters[cid]=!expandedClusters[cid];renderTimeline();return}
  var card=ev.target.closest("[data-entry-card]");
  if(card&&!ev.target.closest("a,button,.q-score")){var ceid=card.getAttribute("data-entry-card");showFullDetail(ceid);return}
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
        content: stripHtmlNL(content),
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

function stripHtmlNL(html: string): string {
  return html
    .replaceAll(/<br\s*\/?>/gi, "\n")
    .replaceAll(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, "\n")
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll(/[ \t\r]+/g, " ")
    .replaceAll(/\n{3,}/g, "\n\n")
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
