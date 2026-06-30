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
import { execFile, execFileSync } from "node:child_process"
import crypto from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"

import type { EntryQualityScoreRecord } from "@follow/shared/entry-quality-score"
import {
  ENTRY_QUALITY_CONTENT_TYPES,
  getQualityScoreTier,
} from "@follow/shared/entry-quality-score"
import { validateQualityScoreResult } from "@follow/store/entry-quality-score/utils"
import { join, resolve as resolvePath } from "pathe"
import type { PluginOption } from "vite"

const RSS_FETCH_TIMEOUT_MS = 30_000
const RSS_ENTRY_LIMIT = 30
// Cloudflare Pages auto-deploy resiliency: a single wrangler upload sometimes
// times out (ETIMEDOUT) when CF is slow, silently dropping the scheduled deploy.
// Retry several times with exponential backoff and a longer per-attempt timeout.
const DEPLOY_MAX_ATTEMPTS = 5
const DEPLOY_TIMEOUT_MS = 300_000
const DEPLOY_RETRY_BASE_MS = 10_000
// When every in-line retry still fails (e.g. a longer CF outage), schedule a
// single delayed background re-deploy so the public site self-heals without
// waiting for the next scheduled slot, and surface a macOS desktop notification.
const DEPLOY_FALLBACK_DELAY_MS = 5 * 60 * 1000
const JINA_READER_BASE = "https://r.jina.ai/"
const DEFUDDLE_BASE = "https://defuddle.md/"
const PUBLIC_SITE_BASE =
  process.env.FINHOT_PUBLIC_BASE_URL || process.env.VITE_PUBLIC_API_BASE || ""
const TOPIC_RECENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
const TOPIC_CLUSTER_TIME_WINDOW_MS = 18 * 60 * 60 * 1000
const TOPIC_SIMILARITY_THRESHOLD = 0.78

// AI enrichment（质量打分 + summary + recommendationReason）只处理近期条目。
// 配合：
// - collector 层的 admitted（四因子廉价准入）
// - Focal 新订阅只拉前 5 条
// 避免对海量历史旧条目做昂贵 LLM 调用。旧条目不打分就进不了非 WeChat 的 public score gate。
const ENRICH_RECENCY_DAYS = 3
const ENRICH_PER_FEED_LIMIT = 5 // 每 feed 最多处理最近 N 条需要 AI 的，对齐 Focal 新订阅只摘前 5 条 + 时效控制

// Whitebox feeds: shown raw on the public snapshot. Their entries skip
// server-side AI enrichment AND bypass the quality score gate, so un-scored
// announcements (e.g. cninfo L3 candidates) still appear — the public mirror of
// PR #84's client-side "Skip AI Enrichment" rule. Matched as case-insensitive
// substrings against the feed URL or category. Configurable via env
// FINHOT_WHITEBOX_FEED_PATTERNS (comma-separated); defaults cover the cninfo-rss
// feeds. Set to an empty string to disable.
const WHITEBOX_FEED_PATTERNS: string[] = (
  process.env.FINHOT_WHITEBOX_FEED_PATTERNS ?? "l3-candidates-hard-delta,cninfo,:8787"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

function isWhiteboxFeed(
  feed: { url?: string | null; category?: string | null } | undefined,
): boolean {
  if (!feed || WHITEBOX_FEED_PATTERNS.length === 0) return false
  const hay = `${feed.url ?? ""}\n${feed.category ?? ""}`.toLowerCase()
  return WHITEBOX_FEED_PATTERNS.some((p) => hay.includes(p))
}

// Local/OpenAI-compatible embeddings endpoint (e.g. a bge-m3 FastAPI server on
// the Mac). When set, server-side enrichment generates an embedding for each
// gated-in entry so topic clustering works without depending on the app. When
// empty, embedding generation is skipped (no-op, safe for CI/other envs).
const EMBEDDING_BASE_URL = (process.env.FINHOT_EMBEDDING_BASE_URL || "").replace(/\/+$/, "")
const EMBEDDING_MODEL = process.env.FINHOT_EMBEDDING_MODEL || "bge-m3"

// ─── Feed-suggestion notifications + read-back ───
// When set, each accepted feed suggestion fires a Server酱 (ServerChan) push to
// WeChat. Holds the ServerChan SendKey (Turbo "SCT…" or v3 "sctp…").
const FEED_SUGGESTION_SERVERCHAN = (process.env.FEED_SUGGESTION_SERVERCHAN || "").trim()
// Token gating the read-only GET /api/public/feed-suggestions endpoint. Empty = endpoint disabled.
const FEED_SUGGESTION_TOKEN = (process.env.FEED_SUGGESTION_TOKEN || "").trim()
// Absolute origin the deployed public page should POST feed suggestions to (e.g.
// a tunnel that reaches this dev server). Empty = same-origin, used in dev or
// when the dev server serves the page directly.
const FEED_SUGGESTION_PUBLIC_API_BASE = (process.env.FEED_SUGGESTION_PUBLIC_API_BASE || "").trim()
// Per-IP rate limit for feed-suggestion submissions. Defaults: 5 per 10 minutes.
// Set the max to 0 to disable rate limiting entirely.
const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const n = Number.parseInt((value || "").trim(), 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}
const FEED_SUGGESTION_RATE_MAX = parsePositiveInt(process.env.FEED_SUGGESTION_RATE_MAX, 5)
const FEED_SUGGESTION_RATE_WINDOW_MS = parsePositiveInt(
  process.env.FEED_SUGGESTION_RATE_WINDOW_MS,
  10 * 60 * 1000,
)
// In-memory sliding window of submission timestamps keyed by client IP.
const feedSuggestionHits = new Map<string, number[]>()

// Resolve the originating client IP, honouring the tunnel/proxy forwarding
// headers (cloudflared sets cf-connecting-ip / x-forwarded-for).
function clientIp(req: {
  headers: Record<string, unknown>
  socket?: { remoteAddress?: string }
}): string {
  const cf = req.headers["cf-connecting-ip"]
  if (typeof cf === "string" && cf.trim()) return cf.trim()
  const xff = req.headers["x-forwarded-for"]
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0]!.trim()
  return req.socket?.remoteAddress || "unknown"
}

// Returns true when the IP is within the allowed rate, recording the hit.
function feedSuggestionRateOk(ip: string): boolean {
  if (FEED_SUGGESTION_RATE_MAX <= 0) return true
  const now = Date.now()
  const recent = (feedSuggestionHits.get(ip) || []).filter(
    (t) => now - t < FEED_SUGGESTION_RATE_WINDOW_MS,
  )
  if (recent.length >= FEED_SUGGESTION_RATE_MAX) {
    feedSuggestionHits.set(ip, recent)
    return false
  }
  recent.push(now)
  feedSuggestionHits.set(ip, recent)
  return true
}

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

// ─── Watchlist auto-import via RSSHub / direct RSS ───

const RSSHUB_BASE_URL = (process.env.RSSHUB_BASE_URL || "http://localhost:1200").replace(/\/+$/, "")
const WATCHLIST_FETCH_CONCURRENCY = 5
const WATCHLIST_FETCH_TIMEOUT_MS = 15_000
// Guest weibo API spacing (ms). Mirrors finhot Python WEIBO_SLEEP; lower default for dev refresh.
const WEIBO_SLEEP_MS = Number(process.env.WEIBO_SLEEP_MS ?? "2000")
// Spacing between per-post long-text detail fetches (statuses/extend).
const WEIBO_DETAIL_SLEEP_MS = Number(process.env.WEIBO_DETAIL_SLEEP_MS ?? "600")
// Cap long-text expansions per uid per refresh to avoid guest API -100 rate limits.
const WEIBO_DETAIL_MAX_PER_UID = Number(process.env.WEIBO_DETAIL_MAX_PER_UID ?? "20")
// Scheduler runs in Beijing time (Asia/Shanghai, fixed UTC+8, no DST).
const SCHEDULE_TIMEZONE = "Asia/Shanghai"
const SCHEDULE_TICK_MS = 30 * 1000

type WatchlistCategory = "微博" | "雪球" | "微信" | "推特"

interface RefreshPlan {
  watchlist: WatchlistCategory[]
  grokX: boolean
}

// Parse the current time in Beijing into hour/minute plus a minute-resolution
// stamp used to de-duplicate scheduler ticks.
function beijingTimeParts(now: Date): { hour: number; minute: number; stamp: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHEDULE_TIMEZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "0"
  const hour = Number(get("hour")) % 24
  const minute = Number(get("minute"))
  const stamp = `${get("year")}-${get("month")}-${get("day")} ${hour}:${minute}`
  return { hour, minute, stamp }
}

// Decide which sources to refresh at the given Beijing time.
//  - 雪球/微博/推特 + Grok native X: every 90 min during 09:30–15:00
//    (09:30, 11:00, 12:30, 14:00) plus a final refresh at the 15:00 close,
//    plus 21:30 and the next morning at 08:30.
//  - 微信 (公众号): only 21:30 and 08:30.
// Returns null when nothing is scheduled for that minute.
function planRefreshAt(hour: number, minute: number): RefreshPlan | null {
  const afterOpen = hour > 9 || (hour === 9 && minute >= 30)
  const beforeClose = hour < 15 || (hour === 15 && minute === 0)
  const inWindow = afterOpen && beforeClose
  // Every 90 minutes anchored at the 09:30 open, plus the 15:00 close.
  const minutesSinceOpen = (hour - 9) * 60 + (minute - 30)
  const atClose = hour === 15 && minute === 0
  const intraday = inWindow && (minutesSinceOpen % 90 === 0 || atClose)
  const eveningSnapshot = hour === 21 && minute === 30
  const morningSnapshot = hour === 8 && minute === 30

  const refreshMarket = intraday || eveningSnapshot || morningSnapshot
  const refreshWechat = eveningSnapshot || morningSnapshot
  if (!refreshMarket && !refreshWechat) return null

  const watchlist: WatchlistCategory[] = []
  if (refreshMarket) watchlist.push("微博", "雪球", "推特")
  if (refreshWechat) watchlist.push("微信")
  return { watchlist, grokX: refreshMarket }
}

// Whether the given Beijing time is inside the intraday trading window
// (09:30–15:00). Used to gate the startup warm-up so that (re)starting the
// dev server outside trading hours never scrapes 微博/雪球.
function isIntradayWindow(hour: number, minute: number): boolean {
  const afterOpen = hour > 9 || (hour === 9 && minute >= 30)
  const beforeClose = hour < 15 || (hour === 15 && minute === 0)
  return afterOpen && beforeClose
}

interface WatchlistRssSource {
  name: string
  url: string
}

interface WatchlistData {
  weibo?: string[]
  xueqiu?: string[]
  wechat?: (string | WatchlistRssSource)[]
  x?: string[]
  rss?: WatchlistRssSource[]
}

interface WatchlistImportJob {
  url: string
  category: string
  // "rss": fetch + parse as RSS/Atom XML.
  // "weibo": m.weibo.cn guest API (genvisitor2 cookie, no login required).
  // "xueqiu": scrape via headful Playwright (bypasses Aliyun WAF, no cookie needed).
  // "twitter": fetch via Nitter/RSSHub (fetchTwitterFeedViaRss).
  kind: "rss" | "weibo" | "xueqiu" | "twitter"
  // Source-specific identifier (e.g. xueqiu user id) for non-RSS kinds.
  ref?: string
}

function findMonorepoRoot(start: string): string {
  let dir = start
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "finhot", "watchlist.json"))) return dir
    const parent = resolvePath(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return start
}

function loadWatchlist(): WatchlistData {
  if (!projectRoot) return {}
  const root = findMonorepoRoot(projectRoot)
  const watchlistPath = join(root, "finhot", "watchlist.json")
  if (!existsSync(watchlistPath)) return {}
  try {
    return JSON.parse(readFileSync(watchlistPath, "utf-8")) as WatchlistData
  } catch {
    return {}
  }
}

// Build the list of feeds to import from the watchlist.
//  - weibo: m.weibo.cn guest API (genvisitor2); no RSSHub / login cookie needed.
//  - xueqiu: scraped via headful Playwright (xueqiu-scraper.mjs); bypasses the
//    Aliyun WAF and needs no cookie, so it does NOT go through RSSHub.
//  - wechat ({ name, url }): fetched directly as-is.
//  - x (推特): fetched via Nitter/RSSHub (fetchTwitterFeedViaRss). This is the
//    second X ingestion path that runs ALONGSIDE the native Grok importer
//    (importGrokX / x_grok_entries.json); both paths share the same
//    finhot://twitter/<handle> feed and derive entry ids from the tweet status
//    id, so the same tweet from either path collapses to one entry.
//  - rss ({ name, url }): generic feeds fetched as-is into the public cache.
//    Used for self-hosted/static sources (e.g. the cninfo L3-candidate feed on
//    :8787) so they reach the deployed snapshot; whitebox feeds additionally
//    skip enrichment and bypass the score gate (see isWhiteboxFeed).
// Plain-string wechat names are skipped because resolving them needs a
// wechat2rss endpoint + token, which is not available to this plugin.
function buildWatchlistImportJobs(data: WatchlistData): WatchlistImportJob[] {
  const jobs: WatchlistImportJob[] = []
  for (const uid of data.weibo ?? []) {
    jobs.push({ url: `finhot://weibo/${uid}`, category: "微博", kind: "weibo", ref: uid })
  }
  for (const id of data.xueqiu ?? []) {
    jobs.push({ url: `finhot://xueqiu/${id}`, category: "雪球", kind: "xueqiu", ref: id })
  }
  for (const item of data.wechat ?? []) {
    if (typeof item === "object" && item.url) {
      jobs.push({ url: item.url, category: "微信", kind: "rss" })
    }
  }
  for (const handle of data.x ?? []) {
    if (typeof handle === "string" && handle.trim()) {
      jobs.push({
        url: `finhot://twitter/${handle}`,
        category: "推特",
        kind: "twitter",
        ref: handle,
      })
    }
  }
  for (const item of data.rss ?? []) {
    if (item && typeof item === "object" && item.url?.trim()) {
      jobs.push({ url: item.url.trim(), category: "RSS", kind: "rss" })
    }
  }
  return jobs
}

async function fetchAndParseFeed(url: string): Promise<{
  feed: ReturnType<typeof parseRssFeed>["feed"]
  entries: ReturnType<typeof parseRssFeed>["entries"]
} | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WATCHLIST_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "FinHot/0.1.4 (RSS Reader)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    })
    clearTimeout(timer)
    if (!res.ok) {
      // Surface actionable upstream failures — otherwise the feed silently
      // stales (the manifest keeps its old updatedAt and only the external
      // monitor notices). The most common one is an expired RSSHub weibo
      // login cookie, which returns a 503 HTML page mentioning WEIBO_COOKIES.
      let hint = `HTTP ${res.status}`
      try {
        const body = await res.text()
        if (/WEIBO_COOKIES|Cookies?\s+expired/i.test(body)) {
          hint =
            "RSSHub WEIBO_COOKIES expired — refresh the weibo login cookie and recreate the rsshub container"
        }
      } catch {
        /* ignore body read errors */
      }
      console.warn(`[FinHot] feed fetch failed: ${url} — ${hint}`)
      return null
    }
    const xml = await res.text()
    if (!xml.includes("<rss") && !xml.includes("<feed") && !xml.includes("<?xml")) {
      console.warn(`[FinHot] feed fetch returned non-feed content: ${url}`)
      return null
    }
    return parseRssFeed(xml, url, RSS_ENTRY_LIMIT)
  } catch (error: unknown) {
    clearTimeout(timer)
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[FinHot] feed fetch error: ${url} — ${message}`)
    return null
  }
}

// Resolve a single import job to a parsed feed + entries, dispatching by kind.
async function runWatchlistImportJob(job: WatchlistImportJob): Promise<{
  feed: ReturnType<typeof parseRssFeed>["feed"]
  entries: ReturnType<typeof parseRssFeed>["entries"]
} | null> {
  if (job.kind === "weibo" && job.ref) {
    try {
      const { mblogs, screenName } = await fetchWeiboTimeline(job.ref)
      const expanded = await expandWeiboMblogs(mblogs, job.ref, RSS_ENTRY_LIMIT)
      return weiboTimelineToFeed(job.ref, screenName, expanded, RSS_ENTRY_LIMIT)
    } catch (error: unknown) {
      if (error instanceof WeiboRateLimited) throw error
      return null
    }
  }
  if (job.kind === "xueqiu" && job.ref) {
    try {
      const { statuses, screenName } = await fetchXueqiuTimeline(job.ref)
      return xueqiuTimelineToFeed(job.ref, screenName, statuses, RSS_ENTRY_LIMIT)
    } catch {
      return null
    }
  }
  if (job.kind === "twitter" && job.ref) {
    return fetchTwitterFeedViaRss(job.ref, RSS_ENTRY_LIMIT)
  }
  return fetchAndParseFeed(job.url)
}

async function autoImportWatchlistFeeds(categories?: WatchlistCategory[]): Promise<number> {
  const allJobs = buildWatchlistImportJobs(loadWatchlist())
  const jobs = categories
    ? allJobs.filter((job) => (categories as string[]).includes(job.category))
    : allJobs
  if (jobs.length === 0) return 0

  let imported = 0
  const weiboJobs = jobs.filter((job) => job.kind === "weibo")
  const otherJobs = jobs.filter((job) => job.kind !== "weibo")

  for (const job of weiboJobs) {
    try {
      const result = await runWatchlistImportJob(job)
      if (result) {
        cacheFeedResult(result.feed, result.entries, job.category)
        imported++
      }
    } catch (error: unknown) {
      if (error instanceof WeiboRateLimited) {
        console.warn(`[FinHot] ${error.message}`)
        break
      }
    }
    if (WEIBO_SLEEP_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, WEIBO_SLEEP_MS))
    }
  }

  for (let i = 0; i < otherJobs.length; i += WATCHLIST_FETCH_CONCURRENCY) {
    const batch = otherJobs.slice(i, i + WATCHLIST_FETCH_CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (job) => ({ job, result: await runWatchlistImportJob(job) })),
    )
    for (const settled of results) {
      if (settled.status === "fulfilled" && settled.value.result) {
        cacheFeedResult(
          settled.value.result.feed,
          settled.value.result.entries,
          settled.value.job.category,
        )
        imported++
      }
    }
  }
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

/**
 * Canonical quality-score prompt — ported verbatim from the desktop app's
 * BYOK quality scorer (`apps/desktop/.../ai/local-byok-quality-score.ts`) so the
 * server-side proxy enrichment produces the SAME 6-dimension scoring the repo
 * defines, instead of an ad-hoc 0-100 number. Do not invent variants here.
 */
const QUALITY_SCORE_SYSTEM_PROMPT = `You are an expert content analyst for an AI-powered RSS reader.

Your task is to evaluate RSS content for knowledge value.

You must:
1. Detect content types.
2. Score the article using six quality dimensions with the full 0-5 rubric below.
3. Explain the reasons clearly.
4. Output valid JSON only.

Do not judge whether the user personally likes the content.
Do not produce markdown.
Do not include extra text outside JSON.
Do not hallucinate facts not present in the input.
If the article content is insufficient, lower confidence and explain why.
Do not output quality_score. The application calculates it from dimension scores.

Critical scoring rules:
- Score each dimension independently. High signal_density does NOT justify high depth or actionability.
- Covering many topics (breadth) is NOT the same as high information_gain. Aggregated digests of third-party news rarely exceed information_gain 3.
- actionability 3+ requires concrete steps, commands, or a reproducible workflow the reader can follow. Knowing a product exists is NOT actionable.
- actionability 0 means pure news or announcements with no practical steps.
- depth 1 means headline-level "what happened" only. Structured sections with one-line summaries per item are still depth 1-2, not depth 4.
- originality 2 means aggregation or curation of third-party sources without original analysis.`

const QUALITY_SCORE_DIMENSION_RUBRIC = `Six scoring dimensions (each 0-5 integer). Weights for quality_score:
information_gain 20%, depth 25%, evidence 15%, actionability 15%, originality 15%, signal_density 10%.

1. information_gain — Does this content provide new information?
   0 = Pure repost | 1 = Repeated reporting | 2 = Minor new details
   3 = Multiple new facts | 4 = First-hand information | 5 = Original discovery

2. depth — How deeply does the content explain the topic?
   0 = Clickbait | 1 = News only | 2 = Basic explanation
   3 = Explains why | 4 = Explains how | 5 = Systematic analysis with cases, limitations, or tradeoffs

3. evidence — How well is the content supported by evidence?
   0 = Pure opinion | 1 = Personal feeling | 2 = Third-party references
   3 = Data or examples | 4 = Experiment or detailed case evidence
   5 = Experiment + data + verifiable sources

4. actionability — Can the reader apply this content?
   0 = Pure news | 1 = Trend discussion | 2 = Directional advice
   3 = Actionable suggestions | 4 = Step-by-step guidance | 5 = Fully reproducible workflow

5. originality — Does the author contribute original thinking or experience?
   0 = Repost | 1 = AI summary or generic summary | 2 = Aggregation
   3 = Personal viewpoint | 4 = Personal practice | 5 = Original framework or method

6. signal_density — How much useful information exists relative to filler?
   0 = Mostly filler | 1 = <10% useful | 2 = ~20% | 3 = ~40% | 4 = ~60% | 5 = >80% useful`

const QUALITY_SCORE_TYPE_CONSTRAINTS = `Type-specific constraints (apply after detecting content_types):

- News >= 60%: depth <= 2, actionability <= 1, originality <= 2
- News >= 75% (single news or digest): information_gain <= 3 unless the author provides first-hand reporting
- Daily digest / roundup / multi-item curation: classify as News-dominant, originality = 2 (aggregation), actionability = 0
- ProductUpdate or model announcement without step-by-step usage: actionability <= 1, depth <= 2
- Tutorial or Workflow >= 30%: actionability may reach 4-5 only when concrete steps or commands are present
- Research: actionability is usually 0-2 unless reproducible methods are included`

const QUALITY_SCORE_FEW_SHOT = `Reference examples (for calibration only — score the actual input, do not copy):

Example A — Daily digest / news roundup:
Input: Multi-section digest listing HN posts, YC startups, and tech headlines. Each item is 1-2 sentences summarizing third-party news.
Output: {"content_types":{"News":0.85,"ProductUpdate":0.15},"scores":{"information_gain":3,"depth":1,"evidence":2,"actionability":0,"originality":2,"signal_density":5},"positive_reasons":["High signal density with minimal filler.","Covers many relevant updates in one scan."],"negative_reasons":["Each item lacks depth and original analysis.","Mostly repackages third-party sources.","No actionable steps or reproducible workflow."],"confidence":0.88,"summary":"A daily AI news digest aggregating third-party tech headlines."}

Example B — Single news item:
Input: AI startup raised $100M Series B with investor quotes and brief market context.
Output: {"content_types":{"News":0.75,"ProductUpdate":0.15,"Opinion":0.1},"scores":{"information_gain":2,"depth":1,"evidence":2,"actionability":0,"originality":1,"signal_density":2},"positive_reasons":["Reports a concrete funding event."],"negative_reasons":["Low practical value.","Mostly repeats announcement information."],"confidence":0.9,"summary":"The article reports an AI startup Series B funding round."}

Example C — Model or product announcement (no tutorial):
Input: A post introducing a new AI model's capabilities, benchmark numbers, pricing, and availability. No usage steps.
Output: {"content_types":{"ProductUpdate":0.7,"News":0.2,"Research":0.1},"scores":{"information_gain":4,"depth":2,"evidence":4,"actionability":0,"originality":2,"signal_density":5},"positive_reasons":["Includes benchmark data and concrete specs.","High signal density."],"negative_reasons":["No implementation steps or reproducible workflow.","Mostly product announcement rather than independent analysis."],"confidence":0.88,"summary":"The post announces a new AI model with benchmark results and availability details."}

Example D — Tutorial with reproducible workflow:
Input: Step-by-step guide with commands, folder structure, and common mistakes for setting up a research automation workflow.
Output: {"content_types":{"Tutorial":0.6,"Workflow":0.3,"CaseStudy":0.1},"scores":{"information_gain":4,"depth":4,"evidence":3,"actionability":5,"originality":3,"signal_density":4},"positive_reasons":["Contains step-by-step guidance.","Provides a complete reproducible workflow."],"negative_reasons":["Evidence is mostly practical rather than data-backed."],"confidence":0.9,"summary":"A practical tutorial for building a research automation workflow."}`

function buildQualityScoreUserPrompt(source: string): string {
  const contentTypes = ENTRY_QUALITY_CONTENT_TYPES.join(", ")

  return `Analyze the following RSS item.

${source}

Allowed content types: ${contentTypes}
Content type scores must add up to approximately 1.0.

${QUALITY_SCORE_DIMENSION_RUBRIC}

${QUALITY_SCORE_TYPE_CONSTRAINTS}

${QUALITY_SCORE_FEW_SHOT}

Write summary, positive_reasons, and negative_reasons in Simplified Chinese (简体中文).
Keep JSON keys in English. Keep scores object keys (information_gain, depth, evidence, actionability, originality, signal_density) in English.

Return JSON following this schema:
{
  "content_types": { "News": 0.85, "ProductUpdate": 0.15 },
  "scores": {
    "information_gain": 3,
    "depth": 1,
    "evidence": 2,
    "actionability": 0,
    "originality": 2,
    "signal_density": 5
  },
  "positive_reasons": ["reason 1"],
  "negative_reasons": ["reason 1"],
  "confidence": 0.88,
  "summary": "One-sentence neutral summary."
}`
}

/**
 * Rich-summary prompt (step 2). Produces a multi-sentence Simplified-Chinese
 * summary, generated ONLY for entries that clear the public score gate so the
 * cheap one-sentence summary from the scoring call is the only cost paid for
 * entries that will never be shown.
 */
const RICH_SUMMARY_SYSTEM_PROMPT = `你是一名专业的财经/科技内容编辑。请用简体中文写一段中立、信息密度高的摘要，让读者不打开原文也能快速抓住要点。
要求：
- 约 120-240 字，分成 2-3 个自然段，每段聚焦一个层面（如：发生了什么 / 关键数据或逻辑 / 对读者的意义）。段与段之间用一个空行分隔。
- 覆盖核心事实、关键数据或观点、以及对读者的意义；不夸张、不臆测、不照抄标题。
- 高亮关键信息：把文中出现的关键公司名、行业/板块概念、核心标的用 == 包裹（如 ==英伟达==、==存储芯片==、==人形机器人==），全文最多高亮 3-4 处；重要书名/栏目可用《》或【】标注。
- 不要高亮数字、涨跌幅、百分比、金额；数字如实保留原文写法（如 12.3%、涨停、3.5 亿元）即可。
- 输出纯文本（仅允许上面的 == 和【】《》标注），不要 markdown 标题/代码块，不要任何前后缀（如"摘要："）。`

function buildRichSummaryUserPrompt(source: string): string {
  return `请为下面的内容写一段分段富摘要（2-3 段，简体中文），并按要求高亮关键信息。\n\n${source}`
}

/**
 * Translation prompt: render non-Chinese entries (mainly English X/Twitter) into
 * Simplified Chinese. Returns a JSON object with translated title + body so the
 * detail page's existing 翻译标题/翻译内容 sections (en.translation) can render.
 */
const TRANSLATION_SYSTEM_PROMPT = `你是一名专业的财经/科技译者。请把用户给出的标题和正文忠实翻译成简体中文。
要求：
- 忠实、通顺、不增删信息，不做总结或评论。
- 保留专有名词、公司名、人名、股票代码/cashtag（如 $NVDA）、产品名的通用译法；不确定时保留英文原文并可在括号内附中文。
- 保留原文的换行与段落结构；不要输出 markdown 标题或代码块。
- 严格输出 JSON 对象，且仅此对象：{"title": "<标题中译，没有标题则空字符串>", "content": "<正文中译>"}`

function buildTranslationUserPrompt(title: string, body: string): string {
  const parts = [
    title ? `标题:\n${title}` : "",
    body ? `正文:\n${body.slice(0, 8000)}` : "",
  ].filter(Boolean)
  return `请翻译下面的内容，并按要求只返回 JSON 对象。\n\n${parts.join("\n\n")}`
}

/** Step 2a: generate a rich multi-sentence summary. Returns null on any failure. */
async function generateRichSummary(
  apiURL: string,
  apiKey: string,
  model: string,
  source: string,
): Promise<string | null> {
  try {
    const res = await fetch(apiURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: RICH_SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: buildRichSummaryUserPrompt(source) },
        ],
        temperature: 0.2,
        stream: false,
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const text = data.choices?.[0]?.message?.content?.trim()
    return text && text.length > 0 ? text : null
  } catch {
    return null
  }
}

/**
 * Heuristic language check: treat an entry as already Chinese when CJK characters
 * dominate its letters. Used to decide whether a translation is worth generating
 * (mainly to catch English X/Twitter content). Returns true when there is nothing
 * translatable so we skip empty work.
 */
function isLikelyChinese(text: string): boolean {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const latin = (text.match(/[A-Z]/gi) ?? []).length
  if (cjk + latin === 0) return true
  return cjk / (cjk + latin) >= 0.2
}

/**
 * Whether text carries actual prose worth translating. Link-only posts (a bare
 * URL, or just @mentions / #tags after the link is stripped) have no real words,
 * and feeding them to the model tends to produce a refusal like
 * "抱歉，我无法访问外部链接……" instead of a translation, so we skip them.
 */
function hasTranslatableProse(text: string): boolean {
  const stripped = text.replaceAll(/https?:\/\/\S+/gi, " ").replaceAll(/\bwww\.\S+/gi, " ")
  const letters = (stripped.match(/[A-Z\u4e00-\u9fff]/gi) ?? []).length
  return letters >= 2
}

/**
 * Detect a model refusal masquerading as a translation, e.g.
 * "抱歉，我无法访问外部链接……" / "I'm unable to access the URL……". These show up
 * when a link-only post slips through and must never be stored as a translation.
 */
function isRefusalTranslation(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return /抱歉|无法访问|无法翻译|无法提供|请提供|请直接提供|cannot (?:access|translate|provide)|unable to (?:access|translate|provide)|i'?m sorry/i.test(
    t,
  )
}

/** Whether an entry still needs a Chinese translation written to en.translation. */
function needsForeignTranslation(entry: CachedEntry, en: CachedEnrichment | undefined): boolean {
  if (en?.translation?.content || en?.translation?.readabilityContent) return false
  const text = `${entry.title ?? ""}\n${stripHtmlToText(entry.content || entry.description || "")}`
  if (!text.trim()) return false
  if (!hasTranslatableProse(text)) return false
  return !isLikelyChinese(text)
}

/**
 * Step 2c: translate a non-Chinese entry's title + body into Simplified Chinese.
 * Returns null on any failure so enrichment can carry on without a translation.
 */
async function generateTranslation(
  apiURL: string,
  apiKey: string,
  model: string,
  title: string,
  body: string,
): Promise<{ title: string | null; content: string | null } | null> {
  if (!title.trim() && !body.trim()) return null
  if (!hasTranslatableProse(`${title}\n${body}`)) return null
  try {
    const res = await fetch(apiURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: TRANSLATION_SYSTEM_PROMPT },
          { role: "user", content: buildTranslationUserPrompt(title, body) },
        ],
        temperature: 0.1,
        stream: false,
        response_format: { type: "json_object" },
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    let text = data.choices?.[0]?.message?.content?.trim() ?? ""
    if (!text) return null
    const fence = text.match(/```(?:json)?([\s\S]*?)```/i)
    if (fence) text = fence[1].trim()
    if (!text.startsWith("{")) {
      const brace = text.match(/\{[\s\S]*\}/)
      if (brace) text = brace[0]
    }
    const parsed = JSON.parse(text) as { title?: unknown; content?: unknown }
    const trTitle = typeof parsed.title === "string" ? parsed.title.trim() : ""
    const trContent = typeof parsed.content === "string" ? parsed.content.trim() : ""
    if (!trTitle && !trContent) return null
    if (isRefusalTranslation(trTitle) || isRefusalTranslation(trContent)) return null
    return { title: trTitle || null, content: trContent || null }
  } catch {
    return null
  }
}

/** Step 2b: generate a local embedding via the OpenAI-compatible endpoint. */
async function generateServerEmbedding(text: string): Promise<number[] | null> {
  if (!EMBEDDING_BASE_URL || !text.trim()) return null
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    const res = await fetch(`${EMBEDDING_BASE_URL}/embeddings`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.slice(0, 8000) }),
    })
    clearTimeout(timeout)
    if (!res.ok) return null
    const data = (await res.json()) as { data?: { embedding?: number[] }[] }
    const vec = data.data?.[0]?.embedding
    return Array.isArray(vec) && vec.length > 0 ? vec : null
  } catch {
    return null
  }
}

/**
 * Parse the LLM JSON response (tolerates code fences / extra text) and validate
 * it against the canonical 6-dimension schema. Returns the full
 * EntryQualityScoreRecord (with quality_score derived via calculateQualityScore)
 * or null when the response does not match the schema.
 */
function parseEnrichmentJson(raw: string): EntryQualityScoreRecord | null {
  if (!raw) return null
  let text = raw.trim()
  const fence = text.match(/```(?:json)?([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  if (!text.startsWith("{")) {
    const brace = text.match(/\{[\s\S]*\}/)
    if (brace) text = brace[0]
  }
  try {
    const obj = JSON.parse(text) as unknown
    return validateQualityScoreResult(obj)
  } catch {
    return null
  }
}

interface EnrichResult {
  enriched: number
  total: number
  errors: string[]
  skipped?: string
}

/**
 * Server-side AI enrichment (two-step):
 *  1. Score the entry (6-dimension qualityScore) and store a cheap one-sentence
 *     fallback summary from the same call.
 *  2. ONLY for entries that clear the public score gate, spend an extra call on
 *     a rich multi-sentence summary, and (when FINHOT_EMBEDDING_BASE_URL is set)
 *     generate a local embedding for topic clustering.
 * This saves tokens (no rich summary for entries that will never be shown) and
 * makes shown entries' summaries richer. Without an LLM key (FINHOT_AI_API_KEY)
 * this is a no-op, so the scheduler can call it unconditionally. Producing
 * qualityScore is what lets non-WeChat platforms (微博/雪球/X) pass the gate.
 *
 * 候选筛选逻辑（关键优化）：
 * - 时间窗口：默认只处理最近 ENRICH_RECENCY_DAYS=3 天（金融消息时效性）。
 * - 每 feed 最多最近 ENRICH_PER_FEED_LIMIT=5 条需要 AI 的（直接对齐 Focal 新订阅只摘前 5 条）。
 * - 必须缺 summary 或 qualityScore 或完整 6 维度 scores 才进入 LLM。
 * - 配合 collector admitted 准入，进一步控制量。
 * - 老条目不打分就自然被 public score gate 挡住。
 * - 手动 batch 可传 maxAgeDays 覆盖。
 */
async function enrichMissingEntries(
  opts: {
    limit?: number
    platform?: string
    apiKey?: string
    baseURL?: string
    model?: string
    maxAgeDays?: number
  } = {},
): Promise<EnrichResult> {
  const apiKey = opts.apiKey || process.env.FINHOT_AI_API_KEY || ""
  const baseURL = opts.baseURL || process.env.FINHOT_AI_BASE_URL || "https://api.openai.com/v1"
  const model = opts.model || process.env.FINHOT_AI_MODEL || "gpt-4o-mini"
  const maxItems = Math.min(opts.limit ?? 30, 50)
  if (!apiKey) return { enriched: 0, total: 0, errors: [], skipped: "no api key" }

  const manifest = readManifest()
  const enrichments = readEnrichments()

  const maxAgeDays = opts.maxAgeDays ?? ENRICH_RECENCY_DAYS
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000
  const now = Date.now()

  let candidates = loadAllCachedEntries().filter((e) => {
    // Whitebox feeds are intentionally never AI-enriched (server-side mirror of
    // the client Skip-AI rule); skip so no tokens are spent on raw-shown entries.
    if (isWhiteboxFeed(manifest.feeds[e.feedId])) return false

    const published = new Date(e.publishedAt ?? 0).getTime()
    if (now - published > maxAgeMs) return false

    const en = enrichments[e.id]
    // Re-enrich entries that are missing a summary/score OR that lack the
    // canonical 6-dimension breakdown (e.g. legacy ad-hoc enrichments), OR that
    // are non-Chinese and still missing a translation (mainly English X/Twitter).
    // 仅近期 + 缺关键字段：避免历史旧条目反复消耗 LLM。
    const needsScore = !en?.summary || en?.qualityScore == null || !en?.qualityDetails?.scores
    return needsScore || needsForeignTranslation(e, en)
  })

  // 每 feed 只取最近的 5 条需要 AI 的（对齐 Focal 新订阅只摘前 5 条规则）。
  // 即使老 feed 积累了很多历史，也只处理其最新 5 条候选。
  // 再叠加时间窗口（金融消息时效性强，3 天足够），双重控制 LLM 量。
  const PER_FEED_AI_LIMIT = ENRICH_PER_FEED_LIMIT
  const byFeed: Record<string, typeof candidates> = {}
  for (const e of candidates) {
    const fid = e.feedId || "unknown"
    ;(byFeed[fid] ||= []).push(e)
  }
  candidates = []
  for (const list of Object.values(byFeed)) {
    list.sort(
      (a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime(),
    )
    candidates.push(...list.slice(0, PER_FEED_AI_LIMIT))
  }

  if (opts.platform) {
    candidates = candidates.filter(
      (e) =>
        detectPlatform(manifest.feeds[e.feedId]?.url, manifest.feeds[e.feedId]?.category) ===
        opts.platform,
    )
  }
  candidates.sort(
    (a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime(),
  )
  const batch = candidates.slice(0, maxItems)
  if (batch.length === 0) return { enriched: 0, total: 0, errors: [] }

  const apiURL = `${baseURL.replace(/\/+$/, "")}/chat/completions`
  let enriched = 0
  const errors: string[] = []
  for (const entry of batch) {
    try {
      const textContent = stripHtmlToText(entry.content || entry.description || "")
      const titleText = stripHtmlToText(entry.title || "")
      const source = [
        titleText ? `标题: ${titleText}` : "",
        entry.url ? `链接: ${entry.url}` : "",
        textContent ? `正文: ${textContent.slice(0, 12000)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n")
      if (!source.trim()) continue

      const existing = enrichments[entry.id]
      const needsScore =
        !existing?.summary || existing?.qualityScore == null || !existing?.qualityDetails?.scores
      const merged: CachedEnrichment = { ...existing }
      // The cheap one-sentence fallback summary from the scoring call; reused as
      // embedding input. Falls back to any existing summary when scoring is skipped.
      let fallbackSummary = existing?.summary ?? ""

      // Step 1: score the entry (only when missing) and store a cheap fallback summary.
      if (needsScore) {
        const aiRes = await fetch(apiURL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: QUALITY_SCORE_SYSTEM_PROMPT },
              { role: "user", content: buildQualityScoreUserPrompt(source) },
            ],
            temperature: 0.1,
            stream: false,
            response_format: { type: "json_object" },
          }),
        })
        if (!aiRes.ok) {
          const errText = await aiRes.text()
          errors.push(`${entry.id}: HTTP ${aiRes.status} ${errText.slice(0, 80)}`)
          continue
        }
        const aiData = (await aiRes.json()) as { choices?: { message?: { content?: string } }[] }
        const parsed = parseEnrichmentJson(aiData.choices?.[0]?.message?.content?.trim() ?? "")
        if (!parsed) {
          errors.push(`${entry.id}: unparseable response`)
          continue
        }
        fallbackSummary = parsed.summary
        merged.summary = parsed.summary
        merged.qualityScore = parsed.quality_score
        merged.qualityTier = getQualityScoreTier(parsed.quality_score)
        merged.selected = deriveSelected({ qualityScore: parsed.quality_score })
        const contentTypes: Record<string, number> = {}
        for (const [key, value] of Object.entries(parsed.content_types)) {
          if (typeof value === "number") contentTypes[key] = value
        }
        merged.qualityDetails = {
          contentTypes,
          scores: parsed.scores,
          positiveReasons: parsed.positive_reasons,
          negativeReasons: parsed.negative_reasons,
          confidence: parsed.confidence,
          summary: parsed.summary,
        }
        // Surface the strongest positive reason as the recommendation rationale.
        if (parsed.positive_reasons[0]) merged.recommendationReason = parsed.positive_reasons[0]
      }
      enrichments[entry.id] = merged

      // Step 2: only entries that clear the public score gate get a rich summary,
      // a Chinese translation (for non-Chinese content), and — if configured — a
      // local embedding. Entries that won't be shown keep the cheap fallback
      // summary from step 1, saving tokens.
      if (passesScoreGateServer(entry, enrichments, manifest)) {
        if (needsScore) {
          const rich = await generateRichSummary(apiURL, apiKey, model, source)
          if (rich) {
            merged.summary = rich
            if (merged.qualityDetails) merged.qualityDetails.summary = rich
          }
          if (EMBEDDING_BASE_URL && !merged.embedding?.length) {
            const embedText = [titleText, rich || fallbackSummary, textContent]
              .filter(Boolean)
              .join("\n")
            const vec = await generateServerEmbedding(embedText)
            if (vec) merged.embedding = vec
          }
        }
        // Translate non-Chinese entries (mainly English X/Twitter) into Chinese so
        // the detail page's 翻译标题/翻译内容 sections can render.
        if (needsForeignTranslation(entry, merged)) {
          const tr = await generateTranslation(apiURL, apiKey, model, titleText, textContent)
          if (tr)
            merged.translation = { ...merged.translation, title: tr.title, content: tr.content }
        }
        enrichments[entry.id] = merged
      }
      enriched++
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${entry.id}: ${msg.slice(0, 80)}`)
    }
  }
  if (enriched > 0) writeEnrichments(enrichments)
  return { enriched, total: batch.length, errors }
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

// 主动关注的账号（公众号/雪球/推特/微博等）统一用「近 ENRICH_RECENCY_DAYS 天 + 分数 >= 25」
// 的低噪声门槛，而非给"大海捞针"设计的高策展门槛——这些都是用户主动订阅的源。
const SCORE_GATE_THRESHOLD = 25
// 每个 feed 在公网展示时最多保留最近 N 条，防止单一账号刷屏灌水。
const PER_FEED_DISPLAY_LIMIT = 5

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
  // Recency gate applies to every feed (anti-stale).
  const published = new Date(entry.publishedAt ?? 0).getTime()
  if (Date.now() - published > ENRICH_RECENCY_DAYS * 24 * 60 * 60 * 1000) return false
  // Whitebox feeds (e.g. cninfo L3 candidates) bypass the AI score gate so their
  // raw, un-enriched announcements still surface on the public snapshot.
  if (isWhiteboxFeed(feed)) return true
  const en = enrichments[entry.id]
  // Only surface entries scored with the canonical 6-dimension system.
  // Legacy ad-hoc enrichments (single qualityScore, no `scores`) are excluded.
  if (!en?.qualityDetails?.scores || Object.keys(en.qualityDetails.scores).length === 0) {
    return false
  }
  // 所有主动订阅的平台统一：近 ENRICH_RECENCY_DAYS 天内 + 分数 >= SCORE_GATE_THRESHOLD。
  const qs = en.qualityScore
  return qs != null && qs >= SCORE_GATE_THRESHOLD
}

/** Keep only the most-recent PER_FEED_DISPLAY_LIMIT entries per feed (anti-flood). */
function capPerFeed(entries: CachedEntry[]): CachedEntry[] {
  const seen: Record<string, number> = {}
  const out: CachedEntry[] = []
  for (const e of [...entries].sort(
    (a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime(),
  )) {
    const n = (seen[e.feedId] ?? 0) + 1
    seen[e.feedId] = n
    if (n <= PER_FEED_DISPLAY_LIMIT) out.push(e)
  }
  return out
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

/** Fire-and-forget Server酱 (ServerChan) push for a new feed suggestion. Never throws. */
async function pushFeedSuggestionServerChan(s: {
  id: string
  platform: string
  at: string
}): Promise<void> {
  const key = FEED_SUGGESTION_SERVERCHAN
  if (!key) return
  // v3 SendKeys ("sctp<id>t...") push to a per-key host; Turbo keys ("SCT...") use sctapi.ftqq.com.
  const host = key.startsWith("sctp")
    ? `https://${(key.match(/^sctp\d+/) ?? ["sctapi"])[0]}.push.ft07.com`
    : "https://sctapi.ftqq.com"
  const url = `${host}/${key}.send`
  const title = "FinHot 新投稿"
  const desp = `平台：${s.platform || "未填"}\nID/链接：${s.id}\n时间：${s.at}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title, desp }).toString(),
      signal: controller.signal,
    })
  } catch (error: unknown) {
    console.warn(
      `[FinHot] ServerChan push failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    clearTimeout(timer)
  }
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

class WeiboRateLimited extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WeiboRateLimited"
  }
}

let weiboGuestCookie: string | null = null

async function renewWeiboGuestCookie(): Promise<string> {
  const res = await fetch("https://visitor.passport.weibo.cn/visitor/genvisitor2", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "FinHot/0.1.4 (RSS Reader)",
    },
    body: "cb=visitor_gray_callback&tid=&from=weibo",
  })
  const text = await res.text()
  const match = /visitor_gray_callback\((.*)\)/s.exec(text)
  if (!match) throw new Error("weibo genvisitor2 parse failed")
  const data = JSON.parse(match[1]!).data as { sub: string; subp: string }
  weiboGuestCookie = `SUB=${data.sub}; SUBP=${data.subp};`
  return weiboGuestCookie
}

async function weiboGuestCookieValue(): Promise<string> {
  if (weiboGuestCookie) return weiboGuestCookie
  const fromEnv = process.env.WEIBO_COOKIE?.trim()
  if (fromEnv) {
    weiboGuestCookie = fromEnv
    return fromEnv
  }
  return renewWeiboGuestCookie()
}

function collectWeiboMblogs(cards: any[]): any[] {
  const out: any[] = []
  for (const card of cards) {
    if (card.mblog) out.push(card.mblog)
    for (const group of card.card_group ?? []) {
      if (group.mblog) out.push(group.mblog)
    }
  }
  return out
}

async function weiboContainerApi(uid: string, cookie: string): Promise<any> {
  const containerid = `107603${uid}`
  const url = `https://m.weibo.cn/api/container/getIndex?type=uid&value=${uid}&containerid=${encodeURIComponent(containerid)}`
  const res = await fetch(url, {
    headers: {
      "User-Agent": "FinHot/0.1.4 (RSS Reader)",
      Cookie: cookie,
      Referer: `https://m.weibo.cn/u/${uid}`,
    },
    signal: AbortSignal.timeout(WATCHLIST_FETCH_TIMEOUT_MS),
  })
  return res.json()
}

async function fetchWeiboTimeline(uid: string): Promise<{ mblogs: any[]; screenName: string }> {
  let data = await weiboContainerApi(uid, await weiboGuestCookieValue())
  if (data.ok !== 1) {
    data = await weiboContainerApi(uid, await renewWeiboGuestCookie())
  }
  if (data.ok === -100) {
    throw new WeiboRateLimited("weibo api ok=-100 (IP 频控，跳过本轮剩余微博)")
  }
  if (data.ok !== 1) {
    throw new Error(`weibo api ok=${data.ok}`)
  }
  const mblogs = collectWeiboMblogs(data.data?.cards ?? [])
  const screenName = data.data?.userInfo?.screen_name ?? mblogs[0]?.user?.screen_name ?? uid
  return { mblogs, screenName }
}

function isWeiboTextTruncated(text: string, blog: any): boolean {
  if (blog?.isLongText === true) return true
  const plain = stripHtml(text || "")
  return /(?:…|\.{2,3})全文\s*$|展开全文/u.test(plain)
}

async function weiboDetailApi(path: string, blogId: string, cookie: string): Promise<any> {
  const url = `https://m.weibo.cn/${path}?id=${encodeURIComponent(blogId)}`
  const res = await fetch(url, {
    headers: {
      "User-Agent": "FinHot/0.1.4 (RSS Reader)",
      Cookie: cookie,
      Referer: `https://m.weibo.cn/detail/${blogId}`,
      "X-Requested-With": "XMLHttpRequest",
    },
    signal: AbortSignal.timeout(WATCHLIST_FETCH_TIMEOUT_MS),
  })
  return res.json()
}

async function fetchWeiboFullText(blogId: string, cookie: string): Promise<string | null> {
  const extend = await weiboDetailApi("statuses/extend", blogId, cookie)
  if (extend.ok === -100) {
    throw new WeiboRateLimited("weibo extend ok=-100 (IP 频控，停止长文补全)")
  }
  if (extend.ok === 1) {
    const raw = extend.data?.longTextContent ?? extend.data?.content
    if (raw) return stripHtmlNL(String(raw))
  }

  const show = await weiboDetailApi("statuses/show", blogId, cookie)
  if (show.ok === -100) {
    throw new WeiboRateLimited("weibo show ok=-100 (IP 频控，停止长文补全)")
  }
  if (show.ok === 1) {
    const mblog = show.data ?? {}
    const raw =
      mblog.longText?.longTextContent ??
      mblog.longTextContent ??
      (mblog.isLongText ? null : mblog.text)
    if (raw) return stripHtmlNL(String(raw))
  }
  return null
}

async function expandWeiboMblogs(mblogs: any[], uid: string, limit: number): Promise<any[]> {
  if (mblogs.length === 0) return mblogs

  const updated = new Map<string, any>()
  let cookie = await weiboGuestCookieValue()
  let cookieRenewed = false
  let expanded = 0

  for (const blog of mblogs.slice(0, limit)) {
    const id = String(blog.id ?? "")
    if (!id || !isWeiboTextTruncated(blog.text ?? "", blog)) continue
    if (expanded >= WEIBO_DETAIL_MAX_PER_UID) break

    try {
      let full = await fetchWeiboFullText(id, cookie)
      if (!full && !cookieRenewed) {
        cookie = await renewWeiboGuestCookie()
        cookieRenewed = true
        full = await fetchWeiboFullText(id, cookie)
      }
      if (full) {
        updated.set(id, { ...blog, text: full, isLongText: false })
        expanded++
      }
    } catch (error: unknown) {
      if (error instanceof WeiboRateLimited) {
        console.warn(`[FinHot] ${error.message} (uid ${uid})`)
        break
      }
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[FinHot] weibo full text ${id} failed: ${message}`)
    }

    if (WEIBO_DETAIL_SLEEP_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, WEIBO_DETAIL_SLEEP_MS))
    }
  }

  if (updated.size > 0) {
    console.info(`[FinHot] weibo ${uid}: expanded ${updated.size} long posts`)
  }
  if (updated.size === 0) return mblogs
  return mblogs.map((blog) => updated.get(String(blog.id ?? "")) ?? blog)
}

function weiboTimelineToFeed(uid: string, screenName: string, mblogs: any[], limit: number) {
  const feedUrl = `finhot://weibo/${uid}`
  const feedId = generateId(feedUrl)

  const feed = {
    id: feedId,
    title: `${screenName}的微博`,
    url: feedUrl,
    description: `微博用户 ${screenName} 的动态`,
    image: null,
    errorAt: null,
    siteUrl: `https://weibo.com/u/${uid}`,
    ownerUserId: null,
    errorMessage: null,
    subscriptionCount: null,
    updatesPerWeek: null,
    latestEntryPublishedAt: null,
    tipUserIds: null as string[] | null,
    updatedAt: new Date().toISOString(),
  }

  const entries = mblogs.slice(0, limit).map((blog: any) => {
    const text = stripHtml(blog.text ?? "")
    const publishedAt = blog.created_at
      ? new Date(blog.created_at).toISOString()
      : new Date().toISOString()
    const link = `https://m.weibo.cn/detail/${blog.id}`
    const entryId = generateId(`${feedUrl}::${blog.id}`)
    const author = blog.user?.screen_name ?? screenName

    return {
      id: entryId,
      title: text.slice(0, 80) || null,
      url: link,
      content: stripHtmlNL(blog.text ?? ""),
      readabilityContent: null,
      readabilityUpdatedAt: null,
      description: text.slice(0, 300) || null,
      guid: String(blog.id),
      author,
      authorUrl: `https://weibo.com/u/${uid}`,
      authorAvatar: blog.user?.profile_image_url ?? null,
      insertedAt: new Date().toISOString(),
      publishedAt,
      media: null,
      categories: null,
      attachments: null,
      extra: null,
      language: "zh-CN",
      feedId,
      inboxHandle: null,
    }
  })

  if (entries.length > 0) {
    feed.latestEntryPublishedAt = entries[0]!.publishedAt
  }

  return { feed, entries }
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

/**
 * Extract the numeric status id from a tweet URL (x.com / twitter.com / Nitter
 * mirrors). Used to derive a stable, path-independent entry id so the same
 * tweet ingested via the RSS path (fetchTwitterFeedViaRss) and the native Grok
 * path (importGrokX) collapses to a single cached entry instead of duplicating.
 */
function twitterStatusId(link: string | null): string | null {
  if (!link) return null
  const match = /\/status(?:es)?\/(\d+)/.exec(link)
  return match ? match[1]! : null
}

/** Canonical entry id for a tweet, shared by both X ingestion paths. */
function twitterEntryId(link: string | null, fallbackId: string): string {
  const sid = twitterStatusId(link)
  return sid ? generateId(`x:status:${sid}`) : fallbackId
}

/**
 * Fetch an X/Twitter user's timeline as a parsed feed via RSS, trying Nitter
 * instances first, then the local RSSHub (localhost:1200), then public RSSHub.
 * Entry URLs are normalized back to x.com and entry ids are rederived from the
 * tweet status id so this path dedups against the native Grok importer.
 * Returns null when every source fails. This is the RSS half of X dual-path.
 */
async function fetchTwitterFeedViaRss(
  handle: string,
  limit: number,
): Promise<{
  feed: ReturnType<typeof parseRssFeed>["feed"]
  entries: ReturnType<typeof parseRssFeed>["entries"]
} | null> {
  const FRESHRSS_UA = "FreshRSS/1.24.0 (Linux; https://freshrss.org)"
  const twitterRssSources: { url: string; ua?: string }[] = [
    // Nitter/xcancel instances — primary, most reliable for Twitter RSS
    { url: `https://xcancel.com/${handle}/rss`, ua: FRESHRSS_UA },
    { url: `https://nitter.privacyredirect.com/${handle}/rss`, ua: FRESHRSS_UA },
    // Local RSSHub (when running)
    { url: `${RSSHUB_BASE_URL}/twitter/user/${handle}` },
    // Public RSSHub instances (least reliable for Twitter)
    { url: `https://rsshub.bestblogs.dev/twitter/user/${handle}` },
    { url: `https://rsshub.app/twitter/user/${handle}` },
  ]

  let xml: string | null = null
  for (const source of twitterRssSources) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)
      const res = await fetch(source.url, {
        signal: controller.signal,
        headers: {
          Accept: "application/rss+xml, application/xml, text/xml",
          ...(source.ua ? { "User-Agent": source.ua } : {}),
        },
      })
      clearTimeout(timeout)
      if (res.ok) {
        const text = await res.text()
        const isXml = text.includes("<rss") || text.includes("<feed") || text.includes("<?xml")
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

  if (!xml) return null

  const feedUrl = `finhot://twitter/${handle}`
  const result = parseRssFeed(xml, feedUrl, limit)
  for (const entry of result.entries) {
    entry.url = normalizeNitterUrl(entry.url)
    entry.id = twitterEntryId(entry.url, entry.id)
  }
  return result
}

export function rssProxyPlugin(): PluginOption {
  return {
    name: "rss-proxy",
    configureServer(server) {
      // Initialize the public feed cache directory
      const rootDir = server.config.root ? resolvePath(server.config.root, "../..") : process.cwd()
      ensureCacheDir(rootDir)

      // Warm the cache once on startup, respecting the schedule so that
      // (re)starting the dev server outside trading hours never scrapes.
      // Grok X is always re-imported (it only reads a local seed file, no
      // network scraping); 微博/雪球 are only warmed during the 09:30–15:00
      // intraday window.
      void (async () => {
        try {
          await importGrokX()
        } catch {
          /* skip */
        }
        const { hour, minute } = beijingTimeParts(new Date())
        if (!isIntradayWindow(hour, minute)) return
        try {
          const n = await autoImportWatchlistFeeds(["微博", "雪球"])
          if (n > 0) console.info(`[FinHot] Auto-imported ${n} watchlist feeds`)
        } catch {
          /* sources unavailable — skip silently */
        }
      })()

      // Time-aware scheduler (Beijing time):
      //  - 雪球/微博/推特 + Grok X: every 90 min 09:30–15:00 (09:30/11:00/12:30/
      //    14:00) plus the 15:00 close, plus 21:30 and 08:30.
      //  - 微信: 21:30 and 08:30 only.
      // New Grok X posts must be fetched by the agent (written to
      // x_grok_entries.json); the scheduler only re-imports whatever seed exists.
      // After each scheduled refresh the freshly cached content is published to
      // Cloudflare Pages (finhot.industry7view.com) when CF_API_TOKEN /
      // CF_ACCOUNT_ID are set in the environment.
      let lastScheduleStamp = ""
      setInterval(() => {
        const { hour, minute, stamp } = beijingTimeParts(new Date())
        if (stamp === lastScheduleStamp) return
        const plan = planRefreshAt(hour, minute)
        if (!plan) return
        lastScheduleStamp = stamp
        void (async () => {
          try {
            if (plan.watchlist.length > 0) await autoImportWatchlistFeeds(plan.watchlist)
            if (plan.grokX) await importGrokX()
          } catch {
            /* skip */
          }
          try {
            const r = await enrichMissingEntries()
            if (r.enriched > 0) console.info(`[FinHot] AI-enriched ${r.enriched} entries`)
          } catch {
            /* enrichment is best-effort */
          }
          // The global pass sorts all platforms newest-first and caps to the top
          // N per cycle, so high-frequency 推特 always fills the budget and the
          // lower-frequency platforms (微信/微博/雪球) get starved — their entries
          // never get scored and so never clear the public score gate, making those
          // sources silently disappear from the public site. Give each lower-frequency
          // platform its own dedicated pass so every platform gets a fair budget.
          for (const platform of ["wechat", "weibo", "xueqiu"]) {
            try {
              const r = await enrichMissingEntries({ platform })
              if (r.enriched > 0) {
                console.info(`[FinHot] AI-enriched ${r.enriched} ${platform} entries`)
              }
            } catch {
              /* enrichment is best-effort */
            }
          }
          await autoDeployIfConfigured()
        })()
      }, SCHEDULE_TICK_MS)

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
            const result = await fetchTwitterFeedViaRss(twitterHandle, limit ?? RSS_ENTRY_LIMIT)
            if (!result) {
              throw new Error(
                `Twitter RSS 暂不可用：所有 Nitter 实例和 RSSHub 公共实例均无法访问。请启动本地 RSSHub (localhost:1200) 或稍后重试。`,
              )
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

      // ─── /api/public/feed-suggestion — Visitors submit feeds they want added ───
      server.middlewares.use("/api/public/feed-suggestion", async (req, res) => {
        if (handleCors(req, res)) return
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }
        if (!feedSuggestionRateOk(clientIp(req))) {
          res.writeHead(429, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(JSON.stringify({ error: "Too many requests" }))
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
          const parsed = JSON.parse(body || "{}")
          const id = String(parsed.id ?? parsed.name ?? "")
            .slice(0, 500)
            .trim()
          if (!id) {
            res.writeHead(400, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ error: "id required" }))
            return
          }
          const suggestion = {
            id,
            platform: String(parsed.platform ?? "")
              .slice(0, 40)
              .trim(),
            at: new Date().toISOString(),
          }
          const file = join(cacheDir, "feed-suggestions.json")
          let list: { id?: unknown; platform?: unknown }[] = []
          if (existsSync(file)) {
            try {
              const existing = JSON.parse(readFileSync(file, "utf-8"))
              if (Array.isArray(existing)) list = existing
            } catch {
              /* start fresh on corrupt file */
            }
          }
          // Dedup: drop an exact (platform + id) repeat — no rewrite, no push.
          const duplicate = list.some(
            (s) => s?.id === suggestion.id && (s?.platform ?? "") === suggestion.platform,
          )
          if (duplicate) {
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            })
            res.end(JSON.stringify({ ok: true, duplicate: true }))
            return
          }
          list.push(suggestion)
          writeFileSync(file, JSON.stringify(list, null, 2))
          void pushFeedSuggestionServerChan(suggestion)
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(JSON.stringify({ ok: true }))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })

      // ─── /api/public/feed-suggestions — token-gated read of submitted suggestions ───
      server.middlewares.use("/api/public/feed-suggestions", async (req, res) => {
        if (handleCors(req, res)) return
        if (req.method !== "GET") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }
        if (!FEED_SUGGESTION_TOKEN) {
          res.writeHead(404, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(JSON.stringify({ error: "Not found" }))
          return
        }
        const parsedUrl = new URL(req.url ?? "/", "http://localhost")
        const token = parsedUrl.searchParams.get("token") ?? ""
        if (token !== FEED_SUGGESTION_TOKEN) {
          res.writeHead(401, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(JSON.stringify({ error: "Unauthorized" }))
          return
        }
        try {
          const file = join(cacheDir, "feed-suggestions.json")
          let list: unknown[] = []
          if (existsSync(file)) {
            const existing = JSON.parse(readFileSync(file, "utf-8"))
            if (Array.isArray(existing)) list = existing
          }
          // Newest first for quick triage.
          const suggestions = [...list].reverse()
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(JSON.stringify({ count: suggestions.length, suggestions }))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
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

      // ─── /api/public/batch-enrich — Server-side AI summary/quality scoring (only recent candidates) ───
      // 默认：最近 3 天 + 每 feed 最多最近 5 条（ENRICH_RECENCY_DAYS + ENRICH_PER_FEED_LIMIT）。
      // 金融消息时效性强，严格对齐 Focal 新订阅只摘前 5 条。显著降低 LLM 调用。
      // 传 maxAgeDays 可覆盖。配合 collector admitted。
      server.middlewares.use("/api/public/batch-enrich", async (req, res) => {
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
          const {
            apiKey: bodyKey,
            baseURL: bodyBase,
            model: bodyModel,
            limit: batchLimit,
            platform: targetPlatform,
            maxAgeDays: bodyMaxAgeDays,
          } = JSON.parse(body || "{}")

          const apiKey = bodyKey || process.env.FINHOT_AI_API_KEY || ""
          const baseURL = bodyBase || process.env.FINHOT_AI_BASE_URL || "https://api.openai.com/v1"
          const model = bodyModel || process.env.FINHOT_AI_MODEL || "gpt-4o-mini"
          const maxItems = Math.min(batchLimit || 20, 50)

          if (!apiKey) {
            res.writeHead(400, { "Content-Type": "application/json" })
            res.end(
              JSON.stringify({
                error: "No API key. Set FINHOT_AI_API_KEY env var or pass apiKey in request body.",
              }),
            )
            return
          }

          const result = await enrichMissingEntries({
            limit: maxItems,
            platform: targetPlatform || undefined,
            apiKey,
            baseURL,
            model,
            maxAgeDays: bodyMaxAgeDays,
          })

          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(
            JSON.stringify({
              ok: true,
              enriched: result.enriched,
              total: result.total,
              errors: result.errors.length > 0 ? result.errors : undefined,
            }),
          )
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

          // Score gate (recency + qualityScore), then cap each feed to its latest few (anti-flood).
          entries = capPerFeed(
            entries.filter((e) => passesScoreGateServer(e, enrichments, manifest)),
          )

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

      // ─── /api/public/refresh — Manually trigger a full watchlist re-import ───
      // (/api/public/refresh-weibo kept as an alias for backward compatibility)
      const handleRefreshWatchlist = async (req: IncomingMessage, res: ServerResponse) => {
        if (handleCors(req, res)) return
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }
        try {
          const watchlist = await autoImportWatchlistFeeds()
          const grokX = await importGrokX()
          const enrich = await enrichMissingEntries().catch(() => null)
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(
            JSON.stringify({
              ok: true,
              imported: watchlist + grokX,
              breakdown: { watchlist, grokX, enriched: enrich?.enriched ?? 0 },
            }),
          )
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Watchlist refresh failed"
          res.writeHead(502, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      }
      server.middlewares.use("/api/public/refresh", handleRefreshWatchlist)
      server.middlewares.use("/api/public/refresh-weibo", async (req, res) => {
        if (handleCors(req, res)) return
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }
        try {
          const imported = await autoImportWatchlistFeeds(["微博"])
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(JSON.stringify({ ok: true, imported, category: "微博" }))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Weibo refresh failed"
          res.writeHead(502, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })

      // ─── Grok native X support (replaces/supplements fragile local RSSHub for X) ───
      // The agent (Grok) uses its built-in x_keyword_search / x_semantic_search tools
      // to fetch fresh posts for watchlist "x" users, normalizes to CachedEntry format,
      // and writes to .finhot-cache/x_grok_entries.json or directly calls this.
      // This avoids Nitter/RSSHub instability.
      interface GrokXPost {
        id: string
        source: string
        title?: string
        content: string
        url: string
        ts: number // unix seconds
      }

      function loadGrokXEntries(): CachedEntry[] {
        const grokFile = join(cacheDir || ensureCacheDir(projectRoot), "x_grok_entries.json")
        if (!existsSync(grokFile)) return []
        try {
          const raw: GrokXPost[] = JSON.parse(readFileSync(grokFile, "utf-8"))
          return raw.map((p) => {
            const screen = (p.source || "").replace(/^X@/, "").replace(/ \(native\)$/, "")
            const feedUrl = `finhot://twitter/${screen || "grok"}`
            const feedId = generateId(feedUrl)
            return {
              id: twitterEntryId(p.url, p.id),
              title: p.title || null,
              url: p.url,
              content: p.content,
              description: p.content.slice(0, 300),
              author: p.source,
              authorUrl: `https://x.com/${screen}`,
              authorAvatar: null,
              insertedAt: new Date().toISOString(),
              publishedAt: new Date(p.ts * 1000).toISOString(),
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
        } catch {
          return []
        }
      }

      async function importGrokX(): Promise<number> {
        const entries = loadGrokXEntries()
        if (entries.length === 0) return 0
        // Group by feedId (per user)
        const byFeed: Record<string, CachedEntry[]> = {}
        for (const e of entries) {
          byFeed[e.feedId] ??= []
          byFeed[e.feedId]!.push(e)
        }
        let count = 0
        for (const [fid, es] of Object.entries(byFeed)) {
          // Create synthetic feed
          const screen = es[0]?.author?.replace(/^X@/, "") || "grok-x"
          const feed = {
            id: fid,
            title: `${screen} - X (native)`,
            url: `finhot://twitter/${screen}`,
            description: `Grok native fetch for @${screen}`,
            image: null,
            errorAt: null,
            siteUrl: `https://x.com/${screen}`,
            ownerUserId: null,
            errorMessage: null,
            subscriptionCount: null,
            updatesPerWeek: null,
            latestEntryPublishedAt: es[0]?.publishedAt || null,
            tipUserIds: null,
            updatedAt: new Date().toISOString(),
          }
          cacheFeedResult(feed, es, "推特")
          count += es.length
        }
        return count
      }

      // Manual trigger for Grok X refresh (agent writes the json first, then calls this)
      server.middlewares.use("/api/public/refresh-x-grok", async (req, res) => {
        if (handleCors(req, res)) return
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Method not allowed" }))
          return
        }
        try {
          const count = await importGrokX()
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(JSON.stringify({ ok: true, imported: count }))
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Grok X refresh failed"
          res.writeHead(502, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: message }))
        }
      })

      // Build the static reader HTML from the local cache and deploy it to
      // Cloudflare Pages (project `finhot` → finhot.industry7view.com).
      // Shared by the manual /api/public/deploy endpoint and the scheduler's
      // auto-deploy step. Returns the deployed preview URL.
      async function deployPublicSite(cfApiToken: string, cfAccountId: string): Promise<string> {
        const manifest = readManifest()
        const enrichments = readEnrichments()
        const allFeeds = Object.values(manifest.feeds).sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )
        // Apply the same score gate as /api/public/items (recency + qualityScore),
        // then cap each feed to its latest PER_FEED_DISPLAY_LIMIT entries (anti-flood).
        // Feeds left with no qualifying entries are dropped from the page.
        const entriesByFeed: Record<string, CachedEntry[]> = {}
        for (const feed of allFeeds) {
          const entriesFile = join(cacheDir, "entries", `${feed.id}.json`)
          if (!existsSync(entriesFile)) continue
          try {
            const parsed: CachedEntry[] = JSON.parse(readFileSync(entriesFile, "utf-8"))
            const gated = capPerFeed(
              parsed.filter((e) => passesScoreGateServer(e, enrichments, manifest)),
            )
            if (gated.length > 0) entriesByFeed[feed.id] = gated
          } catch {
            /* skip */
          }
        }
        const feeds = allFeeds.filter((f) => entriesByFeed[f.id]?.length)
        const allEntries = Object.values(entriesByFeed)
          .flat()
          .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
          .slice(0, 500)

        // Only embed enrichments for entries actually shown on the page.
        // Embeddings (used by the client-side hotspot radar clustering) are
        // large, so including them for every scored item bloats the page past
        // Cloudflare Pages' 25 MiB/file limit. Scope to displayed entries only.
        const displayedIds = new Set<string>()
        for (const list of Object.values(entriesByFeed)) {
          for (const e of list) displayedIds.add(e.id)
        }
        const enrichmentsForPage: Record<string, (typeof enrichments)[string]> = {}
        for (const id of displayedIds) {
          const en = enrichments[id]
          if (en) enrichmentsForPage[id] = en
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

        // The wrangler upload occasionally times out or hits a transient network
        // error (ETIMEDOUT/ECONNRESET/socket hang up) when Cloudflare is slow.
        // Retry a few times with backoff and a longer per-attempt timeout so a
        // single flaky upload no longer silently drops the scheduled deploy.
        let wranglerResult = ""
        let lastError: unknown
        for (let attempt = 1; attempt <= DEPLOY_MAX_ATTEMPTS; attempt++) {
          try {
            wranglerResult = execSync(
              `npx wrangler pages deploy "${tmpDir}" --project-name finhot --branch main --commit-dirty=true`,
              {
                env: {
                  ...process.env,
                  CLOUDFLARE_API_TOKEN: cfApiToken,
                  CLOUDFLARE_ACCOUNT_ID: cfAccountId,
                },
                timeout: DEPLOY_TIMEOUT_MS,
                encoding: "utf-8",
              },
            )
            break
          } catch (error: unknown) {
            lastError = error
            if (attempt >= DEPLOY_MAX_ATTEMPTS) break
            const message = error instanceof Error ? error.message : String(error)
            const delayMs = DEPLOY_RETRY_BASE_MS * 2 ** (attempt - 1)
            console.warn(
              `[FinHot] wrangler deploy attempt ${attempt}/${DEPLOY_MAX_ATTEMPTS} failed: ${message} — retrying in ${delayMs}ms`,
            )
            execSync(`sleep ${Math.round(delayMs / 1000)}`)
          }
        }
        if (!wranglerResult) {
          throw lastError instanceof Error ? lastError : new Error("wrangler deploy failed")
        }
        const urlMatch = wranglerResult.match(/https:\/\/[a-z0-9]+\.finhot\.pages\.dev/)
        return urlMatch?.[0] ?? "https://finhot.industry7view.com"
      }

      // Best-effort macOS desktop notification (used to flag a deploy that
      // failed even after every retry). No-op on non-macOS or when osascript
      // is unavailable, so it never throws into the scheduler.
      function notifyDesktop(title: string, message: string): void {
        if (process.platform !== "darwin") return
        try {
          const esc = (s: string) => s.replaceAll(/["\\]/g, "\\$&")
          execFileSync(
            "osascript",
            ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`],
            { timeout: 10_000 },
          )
        } catch {
          /* notification is best-effort */
        }
      }

      // Persist the outcome of the most recent auto-deploy so the external
      // monitor can read a machine-readable status instead of scraping logs.
      function writeDeployHealth(status: "ok" | "failed", detail: string): void {
        try {
          writeFileSync(
            join(cacheDir, "deploy-health.json"),
            JSON.stringify({ status, detail, at: new Date().toISOString() }, null, 2),
            "utf-8",
          )
        } catch {
          /* health file is best-effort */
        }
      }

      // Tracks the pending fallback re-deploy timer so overlapping schedule
      // ticks don't pile up multiple delayed retries.
      let fallbackDeployTimer: ReturnType<typeof setTimeout> | null = null

      // Auto-deploy to Cloudflare Pages after a scheduled refresh, when CF
      // credentials are present in the environment. No-op (returns false)
      // when credentials are missing, so the scheduler stays self-contained.
      // On total failure (after all inline retries), emits a macOS notification
      // and schedules a single delayed background re-deploy so a longer CF
      // outage self-heals without waiting for the next scheduled slot.
      async function autoDeployIfConfigured(isFallback = false): Promise<boolean> {
        const cfApiToken = process.env.CF_API_TOKEN
        const cfAccountId = process.env.CF_ACCOUNT_ID
        if (!cfApiToken || !cfAccountId) return false
        try {
          const url = await deployPublicSite(cfApiToken, cfAccountId)
          console.info(`[FinHot] Auto-deployed public site → ${url}`)
          writeDeployHealth("ok", url)
          if (fallbackDeployTimer) {
            clearTimeout(fallbackDeployTimer)
            fallbackDeployTimer = null
          }
          return true
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          console.warn(`[FinHot] Auto-deploy failed: ${message}`)
          writeDeployHealth("failed", message)
          if (!isFallback && !fallbackDeployTimer) {
            const minutes = Math.round(DEPLOY_FALLBACK_DELAY_MS / 60_000)
            notifyDesktop(
              "FinHot 部署失败",
              `公网部署失败：${message}。将在 ${minutes} 分钟后自动重试。`,
            )
            console.warn(`[FinHot] Scheduling fallback re-deploy in ${minutes}min`)
            fallbackDeployTimer = setTimeout(() => {
              fallbackDeployTimer = null
              void autoDeployIfConfigured(true)
            }, DEPLOY_FALLBACK_DELAY_MS)
            if (typeof fallbackDeployTimer.unref === "function") fallbackDeployTimer.unref()
          } else if (isFallback) {
            notifyDesktop("FinHot 部署仍失败", `自动重试后公网部署仍失败：${message}。请手动检查。`)
          }
          return false
        }
      }

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
          const parsed = JSON.parse(body || "{}")
          const cfApiToken = parsed.cfApiToken || process.env.CF_API_TOKEN
          const cfAccountId = parsed.cfAccountId || process.env.CF_ACCOUNT_ID
          if (!cfApiToken || !cfAccountId) {
            res.writeHead(400, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ error: "cfApiToken and cfAccountId required" }))
            return
          }

          const url = await deployPublicSite(cfApiToken, cfAccountId)
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          })
          res.end(JSON.stringify({ ok: true, url }))
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

  // Inline highlight: ==key==→<mark>, 《》/【】→bold, tag terms (company/industry
  // concepts)→<mark class="hl-tag">. Done in a single pass so a term inside an
  // already-marked segment is never wrapped twice.
  const escapeReg = (t: string): string => t.replaceAll(/[.*+?^|(){}[\]\\]/g, "\\$&")
  const highlightInline = (line: string, hl?: string[]): string => {
    const terms = (hl ?? [])
      .map((t) => t.trim())
      .filter((t, i, a) => t.length >= 2 && a.indexOf(t) === i)
      .sort((a, b) => b.length - a.length)
    const alt = terms.map(escapeReg).join("|")
    const re = new RegExp(`==([^=]+)==|《([^》]+)》|【([^】]+)】${alt ? `|(${alt})` : ""}`, "g")
    return line.replaceAll(re, (m, a, b, c, d) => {
      if (a != null) return `<mark>${a}</mark>`
      if (b != null) return `<strong>《${b}》</strong>`
      if (c != null) return `<strong>【${c}】</strong>`
      if (d != null) return `<mark class="hl-tag">${d}</mark>`
      return m
    })
  }
  // Render a summary as paragraphs with highlighting; auto-splits flat text.
  const richSummaryHtml = (raw: string, hl?: string[]): string => {
    let body = esc(raw.trim())
    if (!body) return ""
    if (!body.includes("\n")) {
      const sents = body.match(/[^。！？!?\n]+[。！？!?]+/g)
      if (sents && sents.length >= 3) {
        const paras: string[] = []
        for (let i = 0; i < sents.length; i += 2) paras.push(sents.slice(i, i + 2).join(""))
        body = paras.join("\n")
      }
    }
    return body
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `<p>${highlightInline(line, hl)}</p>`)
      .join("")
  }

  const score = en.qualityScore ?? null
  const sel = deriveSelected(en)
  const selText =
    sel === "selected" && score != null
      ? `精选 ${score}`
      : sel === "watch" && score != null
        ? `观察 ${score}`
        : ""
  const reason = en.recommendationReason ?? ""
  const isWechat = detectPlatform(feed?.url, feed?.category) === "wechat"
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
  const isWeiboFeed = feed ? detectPlatform(feed.url, feed.category) === "weibo" : false
  const contentDuplicatesTitle = isWeiboFeed
    ? false
    : isSubstantiallyDuplicateText(entry.title, contentSource)
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
.summary-text.rich p{margin:0 0 10px}.summary-text.rich p:last-child{margin-bottom:0}.summary-text.rich strong{font-weight:700}.summary-text mark{background:rgba(255,184,0,.22);color:inherit;padding:0 3px;border-radius:4px;font-weight:600}.summary-text mark.hl-tag{background:rgba(255,69,58,.14);color:#c81e1e;font-weight:600}
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
  .summary-text mark{background:rgba(255,200,40,.2);color:#ffe9a8}.summary-text mark.hl-tag{background:rgba(255,105,97,.2);color:#ff9d97}
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
  reason && !isWechat
    ? `<div class="section reason"><div class="section-title">精选理由</div><div class="summary-text">${esc(reason)}</div></div>`
    : ""
}
${
  summary
    ? `<div class="section"><div class="section-title">AI 摘要</div><div class="summary-text rich">${richSummaryHtml(summary, tags)}</div></div>`
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
<link rel="icon" href="data:image/png;base64,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" type="image/png">
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
.brand{height:40px;display:flex;align-items:center;justify-content:space-between;margin:0 12px 0 16px;gap:8px}.brand-main{display:flex;align-items:center;gap:8px;min-width:0}.brand-mark{width:26px;height:26px;border-radius:7px;overflow:hidden;flex:0 0 26px}.brand-mark img{width:100%;height:100%;object-fit:cover}.brand-title{font-size:17px;font-weight:800;letter-spacing:-.02em;font-style:italic;background:linear-gradient(135deg,#ff6b35,#f7931e,#ff4500,#ff6b35);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;text-shadow:0 0 20px rgba(255,107,53,0.3);filter:drop-shadow(0 0 2px rgba(255,107,53,0.2))}.brand-sub{display:none}
.brand-tools{display:flex;align-items:center;gap:6px;color:rgba(var(--color-textSecondary))}.brand-tool{width:24px;height:24px;border:0;border-radius:7px;background:transparent;color:inherit;display:flex;align-items:center;justify-content:center;cursor:pointer}.brand-tool:hover{background:rgba(var(--color-fillSecondary));color:rgba(var(--color-text))}
.side-scroll{flex:1;overflow:auto;margin-top:12px;padding:0 8px 10px;scrollbar-width:thin}.nav-section{height:28px;display:flex;align-items:center;padding:12px 10px 4px;font-size:12px;font-weight:650;color:rgba(var(--color-textTertiary));letter-spacing:.02em}
.nav-item{width:100%;height:44px;border:0;background:transparent;border-radius:10px;color:rgba(var(--color-text));font:inherit;font-size:15px;font-weight:500;line-height:1.5;display:flex;align-items:center;gap:10px;padding:0 12px;cursor:pointer;text-align:left;transition:background .15s,color .15s}
.nav-item:hover{background:rgba(var(--color-fillSecondary));color:rgba(var(--color-text))}.nav-item.active{background:hsl(var(--fo-a) / .12);color:hsl(var(--fo-a));font-weight:650}
.nav-ico{width:22px;height:22px;display:flex;align-items:center;justify-content:center;flex:0 0 22px;opacity:.85}.nav-ico svg{width:20px;height:20px}.feed-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.count{margin-left:auto;font-size:12px;color:rgba(var(--color-textTertiary));font-variant-numeric:tabular-nums;background:rgba(var(--color-fillSecondary));padding:1px 7px;border-radius:10px}.active .count{color:hsl(var(--fo-a) / .8);background:hsl(var(--fo-a) / .08)}
.nav-divider{height:1px;margin:8px 12px;background:linear-gradient(to right,transparent,rgba(var(--color-fillSecondary)),transparent)}
.sidebar-footer{padding:8px 12px 8px;color:rgba(var(--color-textTertiary));font-size:12px}.theme-row{display:flex;gap:4px}.theme-btn{width:24px;height:24px;border:0;border-radius:7px;background:transparent;color:rgba(var(--color-textTertiary));cursor:pointer}.theme-btn.active,.theme-btn:hover{color:hsl(var(--fo-a));background:hsl(var(--fo-a) / .08)}
.obs-modal{display:none;position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.42);align-items:center;justify-content:center;padding:20px}.obs-modal.open{display:flex}.obs-dialog{width:100%;max-width:420px;background:hsl(var(--background));border:1px solid hsl(var(--border));border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.3);padding:20px;color:rgba(var(--color-text))}.obs-dialog-head{display:flex;align-items:center;justify-content:space-between;font-size:16px;font-weight:740;margin-bottom:16px}.obs-x{border:0;background:transparent;color:rgba(var(--color-textTertiary));font-size:15px;cursor:pointer;width:28px;height:28px;border-radius:7px}.obs-x:hover{background:rgba(var(--color-fillSecondary))}.obs-field{margin-bottom:12px;display:flex;flex-direction:column;gap:5px}.obs-field label{font-size:12.5px;font-weight:600;color:rgba(var(--color-textSecondary))}.obs-field input{height:36px;border:1px solid hsl(var(--border));border-radius:9px;background:rgba(var(--color-fillTertiary));padding:0 11px;font:inherit;font-size:14px;color:rgba(var(--color-text));outline:none}.obs-field input:focus{border-color:hsl(var(--fo-a) / .5)}.obs-hint{font-size:12px;line-height:1.62;color:rgba(var(--color-textTertiary));background:rgba(var(--color-fillTertiary));border-radius:9px;padding:9px 11px;margin:2px 0 16px}.obs-hint b{color:rgba(var(--color-textSecondary))}.obs-actions{display:flex;justify-content:flex-end;gap:8px}.obs-btn,.obs-btn-ghost{height:36px;padding:0 16px;border-radius:9px;font:inherit;font-size:14px;font-weight:600;cursor:pointer;border:1px solid transparent}.obs-btn{background:hsl(var(--fo-a));color:#fff}.obs-btn:hover{filter:brightness(1.06)}.obs-btn-ghost{background:transparent;border-color:hsl(var(--border));color:rgba(var(--color-textSecondary))}.obs-btn-ghost:hover{background:rgba(var(--color-fillSecondary))}.obs-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%) translateY(20px);z-index:2100;background:rgba(20,20,22,.94);color:#fff;font-size:13.5px;font-weight:500;padding:11px 18px;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.32);opacity:0;pointer-events:none;transition:opacity .22s ease,transform .22s ease;max-width:90vw}.obs-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
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
.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}.feed-icon{width:20px;height:20px;border-radius:7px;background:rgba(var(--color-fillSecondary));display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:rgba(var(--color-textTertiary));overflow:hidden}.feed-icon img{width:100%;height:100%;object-fit:cover}.source{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(var(--color-textSecondary));font-size:12px;font-weight:500}.time{font-size:12px;color:rgba(var(--color-textTertiary));white-space:nowrap}.q{min-width:26px;border-radius:8px;padding:2px 8px;text-align:center;font-size:12px;font-weight:720;font-variant-numeric:tabular-nums}.q-high{background:rgba(var(--color-fillTertiary));color:rgba(var(--color-textSecondary));border:1px solid rgba(var(--color-fillSecondary))}.q-medium{background:rgba(var(--color-fillTertiary));color:rgba(var(--color-textSecondary));border:1px solid rgba(var(--color-fillSecondary))}.q-low{background:rgb(var(--color-gray) / .12);color:rgba(var(--color-textSecondary));border:1px solid rgb(var(--color-gray) / .13)}.q-wrap{position:relative;display:inline-flex;flex:0 0 auto}.q-wrap:focus{outline:none}.q-detail{display:none;position:fixed;left:0;top:0;z-index:1000;pointer-events:none;width:320px;max-width:min(320px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow-y:auto;padding:10px;border:1px solid hsl(var(--border));border-radius:12px;background:hsl(var(--background));box-shadow:0 10px 28px rgba(0,0,0,.12);color:rgba(var(--color-text));font-size:11px;font-weight:400;line-height:1.45}.q-detail-title{font-size:12px;font-weight:720;margin-bottom:4px}.q-detail-muted{color:rgba(var(--color-textTertiary))}.q-grid{display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;margin-top:6px}.q-types{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}.q-reasons{margin-top:6px;padding-left:14px}
.card.open{border-color:hsl(var(--fo-a) / .5);background:linear-gradient(#fff,#f8fbff);box-shadow:0 1px 2px rgba(15,23,42,.06),0 8px 24px rgba(15,23,42,.06)}.card-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:15.5px;font-weight:640;letter-spacing:-.01em;line-height:1.48;color:rgba(var(--color-text));word-break:break-word;text-decoration:none;transition:color .18s ease}.card-title:hover{color:hsl(var(--fo-a))}button.card-title{width:100%;border:0;background:transparent;text-align:left;font-family:inherit;cursor:pointer;padding:0}.desc{margin-top:12px;font-size:13.5px;font-weight:400;line-height:1.65;color:rgba(var(--color-textSecondary));display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;letter-spacing:.005em}.card-reason{margin-top:12px;padding:4px 10px;border:0;border-radius:8px;background:rgba(52,211,153,.08);color:#047857;font-size:12px;font-weight:480;line-height:1.58;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}.card-foot{display:flex;align-items:center;gap:6px;margin-top:11px;padding-top:0}.tags{display:flex;flex-wrap:wrap;gap:6px;min-width:0;flex:1}.tag{border-radius:6px;background:rgba(var(--color-fillSecondary));color:rgba(var(--color-textSecondary));font-size:11.5px;padding:2px 7px;font-weight:500;letter-spacing:.01em}.tag-analysis,.tag-fen-xi,.tag-industry,.tag-hang-ye,.tag-business,.tag-shang-ye,.tag-opinion,.tag-guan-dian,.tag-kuai-xun,.tag-tech,.tag-ai{background:rgba(var(--color-fillSecondary));color:rgba(var(--color-textSecondary))}.cluster{border:0;border-radius:6px;background:rgb(var(--color-blue) / .09);color:rgb(var(--color-blue));font:inherit;font-size:12px;padding:3px 8px;cursor:pointer}.cluster.on{background:hsl(var(--fo-a) / .13);color:hsl(var(--fo-a))}.member{margin-left:24px;opacity:.9}.ai-panel{margin-top:10px;border-radius:12px;border:1px solid hsl(var(--fo-a) / .18);background:linear-gradient(135deg,hsl(var(--fo-a) / .07),transparent 52%),rgba(var(--color-fillQuaternary));box-shadow:0 8px 24px rgba(0,0,0,.045);overflow:hidden}.ai-card{padding:12px}.ai-head{display:flex;align-items:center;justify-content:space-between;gap:8px;color:hsl(var(--fo-a));font-size:12px;font-weight:720}.ai-title{display:flex;align-items:center;gap:6px}.ai-dot{width:8px;height:8px;border-radius:999px;background:hsl(var(--fo-a));box-shadow:0 0 0 4px hsl(var(--fo-a) / .12)}.ai-body{margin-top:9px;color:rgba(var(--color-text));font-size:13px;line-height:1.62;white-space:pre-wrap;word-break:break-word}.ai-section{border-top:1px solid hsl(var(--border) / .62);padding:12px}.ai-section-title{font-size:12px;font-weight:720;color:rgba(var(--color-textSecondary));margin-bottom:7px}.ai-link{display:inline-flex;align-items:center;gap:5px;margin-top:10px;color:hsl(var(--fo-a));font-size:12px;font-weight:650}.translation-title{font-size:13px;font-weight:680;color:rgba(var(--color-text));margin-bottom:6px}
.detail-panel{display:none;flex:0 0 500px;min-width:0;max-width:520px;min-height:0;overflow:hidden;scrollbar-width:thin;background:hsl(var(--background))}.has-detail .detail-panel{display:flex;flex-direction:column}.detail-header{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:8px;padding:10px 18px;background:hsl(var(--background));border-bottom:1px solid rgba(var(--color-fillTertiary))}.detail-close-btn{width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:rgba(var(--color-textSecondary));cursor:pointer;display:flex;align-items:center;justify-content:center;flex:0 0 28px}.detail-close-btn:hover{background:rgba(var(--color-fillSecondary));color:rgba(var(--color-text))}.detail-header-title{flex:1;min-width:0;font-size:13px;font-weight:600;color:rgba(var(--color-textSecondary));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.detail-header-tools{display:flex;gap:4px}.detail-header-tools a,.detail-header-tools button{width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:rgba(var(--color-textSecondary));cursor:pointer;display:flex;align-items:center;justify-content:center;text-decoration:none}.detail-header-tools a:hover,.detail-header-tools button:hover{background:rgba(var(--color-fillSecondary));color:rgba(var(--color-text))}
.detail-scroll{flex:1;min-height:0;overflow-y:auto;padding:32px 28px 48px;scrollbar-width:thin;-webkit-overflow-scrolling:touch}
.detail-title{font-size:26px;font-weight:780;line-height:1.32;color:rgba(var(--color-text));letter-spacing:-.018em;word-break:break-word}
.detail-title.long{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;font-size:22px;font-weight:760;line-height:1.32;color:rgba(var(--color-text))}
.detail-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:12px;padding-bottom:16px;border-bottom:1px solid rgba(var(--color-fillTertiary))}.detail-meta-icon{width:22px;height:22px;border-radius:6px;background:rgba(var(--color-fillSecondary));display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:750;color:rgba(var(--color-textTertiary));overflow:hidden}.detail-meta-icon img{width:100%;height:100%;object-fit:cover}.detail-meta-source{font-size:13px;font-weight:620;color:rgba(var(--color-textSecondary))}.detail-meta-dot{width:3px;height:3px;border-radius:50%;background:rgba(var(--color-textTertiary));flex:0 0 3px}.detail-meta-plat{font-size:12px;color:rgba(var(--color-textTertiary))}.detail-meta-time{font-size:12px;color:rgba(var(--color-textTertiary));display:flex;align-items:center;gap:4px}
.detail-ai{margin-top:24px;border-radius:12px;border:1px solid hsl(var(--fo-a) / .12);border-left:3px solid hsl(var(--fo-a) / .45);background:linear-gradient(135deg,hsl(var(--fo-a) / .035),transparent 54%);padding:20px 22px;overflow:hidden;box-shadow:0 2px 8px hsl(var(--fo-a) / .04)}.detail-ai-head{display:flex;align-items:center;gap:7px;color:hsl(var(--fo-a));font-size:14px;font-weight:720}.detail-ai-head svg{width:16px;height:16px;flex:0 0 16px}.detail-ai-body{margin-top:14px;font-size:15px;line-height:1.75;color:rgba(var(--color-text));word-break:break-word}.detail-ai-label{margin-top:18px;font-size:12.5px;font-weight:660;color:rgba(var(--color-textSecondary))}.detail-ai-value{margin-top:6px;font-size:15px;line-height:1.72;color:rgba(var(--color-text))}
.detail-ai-body p,.fp-section-body p,.ai-body p{margin:0 0 10px}.detail-ai-body p:last-child,.fp-section-body p:last-child,.ai-body p:last-child{margin-bottom:0}.detail-ai-body h3,.fp-section-body h3,.ai-body h3{font-size:14.5px;font-weight:720;margin:14px 0 6px;color:rgba(var(--color-text))}.detail-ai-body h4,.fp-section-body h4,.ai-body h4{font-size:13.5px;font-weight:700;margin:10px 0 5px;color:rgba(var(--color-textSecondary))}.detail-ai-body ul,.fp-section-body ul,.ai-body ul{margin:6px 0;padding-left:20px}.detail-ai-body li,.fp-section-body li,.ai-body li{margin:3px 0}.detail-ai-body mark,.fp-section-body mark,.ai-body mark{background:hsl(var(--fo-a) / .18);color:inherit;padding:0 3px;border-radius:4px;font-weight:600}.detail-ai-body mark.hl-tag,.fp-section-body mark.hl-tag,.ai-body mark.hl-tag{background:rgb(var(--color-red) / .15);color:rgb(var(--color-red));font-weight:600}.art-sep{display:inline-block;font-size:11px;font-weight:700;color:rgba(var(--color-textTertiary));margin:8px 0 4px}
.detail-rec{margin-top:14px;padding:14px 16px;border-radius:10px;background:rgba(var(--color-fillQuaternary));border:1px solid rgba(var(--color-fillTertiary));border-left:3px solid rgba(var(--color-fillSecondary));color:rgba(var(--color-textSecondary));font-size:15px;line-height:1.68;font-weight:560}
.detail-section{margin-top:20px;padding-top:16px;border-top:1px solid rgba(var(--color-fillTertiary))}
.detail-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.detail-section-title{font-size:13px;font-weight:720;color:rgba(var(--color-textSecondary));letter-spacing:0}.detail-section-action{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;color:hsl(var(--fo-a));font-size:12px;font-weight:650;text-decoration:none}.detail-section-action:hover{text-decoration:underline}
.detail-body{font-size:15px;line-height:1.78;color:color-mix(in srgb, rgba(var(--color-text)) 84%, transparent);word-break:break-word;font-weight:400;white-space:pre-wrap}.detail-body p{margin-bottom:10px}.detail-source-note{font-size:12.5px;line-height:1.58;color:rgba(var(--color-textTertiary));background:rgba(var(--color-fillQuaternary));border:1px solid rgba(var(--color-fillTertiary));border-radius:8px;padding:8px 10px}
.detail-link{display:inline-flex;align-items:center;gap:5px;margin-top:16px;padding:8px 14px;border-radius:8px;background:hsl(var(--fo-a) / .08);color:hsl(var(--fo-a));font-size:13px;font-weight:620;text-decoration:none;border:1px solid hsl(var(--fo-a) / .16)}.detail-link:hover{background:hsl(var(--fo-a) / .14)}
.detail-qd{margin-top:16px;padding:13px 14px;border-radius:10px;border:1px solid hsl(var(--border));background:rgba(var(--color-fillQuaternary))}.detail-qd-title{font-size:12.5px;font-weight:720;margin-bottom:7px}.detail-qd-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px 12px;font-size:12.5px;color:rgba(var(--color-textSecondary))}.detail-qd-grid span{display:flex;justify-content:space-between}.detail-qd-muted{color:rgba(var(--color-textTertiary));font-size:11px;margin-top:6px}.detail-qd-reasons{margin-top:7px;padding-left:14px;font-size:12.5px;line-height:1.55;color:rgba(var(--color-textSecondary))}.detail-qd-reasons.negative{color:rgba(var(--color-textTertiary))}
.radar-wrap{display:flex;flex-direction:column;gap:8px;padding:4px 4px 26px}.radar-card{overflow:hidden;border:1px solid hsl(var(--fo-a) / .14);border-radius:12px;background:linear-gradient(135deg,hsl(var(--fo-a) / .03),transparent 46%),rgba(var(--color-fillQuaternary));box-shadow:0 2px 8px hsl(var(--fo-a) / .04),0 1px 3px rgba(0,0,0,.04);transition:box-shadow .25s ease,border-color .25s ease}.radar-card:hover{border-color:hsl(var(--fo-a) / .24);box-shadow:0 4px 16px hsl(var(--fo-a) / .08),0 2px 8px rgba(0,0,0,.05)}.radar-main{width:100%;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:flex-start;gap:10px;padding:12px}.radar-main:hover{background:rgba(var(--color-fillQuaternary))}.radar-title-row{display:flex;align-items:flex-start;gap:8px}.radar-title{flex:1;min-width:0;font-size:14px;font-weight:680;line-height:1.35}.heat{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:hsl(var(--fo-a));white-space:nowrap}.heat-dot{width:7px;height:7px;border-radius:999px;background:hsl(var(--fo-a));box-shadow:0 0 0 3px hsl(var(--fo-a) / .12)}.chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}.chip{border-radius:6px;background:rgba(var(--color-fillTertiary));color:rgba(var(--color-textSecondary));font-size:11px;padding:2px 6px}.meta{display:flex;gap:12px;margin-top:7px;color:rgba(var(--color-textTertiary));font-size:11px}.radar-chevron{width:16px;color:rgba(var(--color-textTertiary));transition:transform .15s}.radar-card.open .radar-chevron{transform:rotate(180deg)}.radar-entries{display:none;border-top:1px solid hsl(var(--fo-a) / .13);padding:7px 10px 10px}.radar-card.open .radar-entries{display:block}.radar-entry{display:flex;align-items:center;gap:8px;border-radius:8px;padding:6px 6px;color:rgba(var(--color-textSecondary));font-size:12px;cursor:pointer}.radar-entry:hover{background:rgba(var(--color-fillQuaternary));color:rgba(var(--color-text))}.radar-entry-title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty{height:300px;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;color:rgba(var(--color-textTertiary));font-size:13px}.empty svg{width:38px;height:38px;opacity:.38}
.fp-about{max-width:680px;margin:0 auto;padding:56px 24px 64px;animation:fadeUp .3s ease both}.fp-about-eyebrow{font-size:13px;font-weight:650;color:hsl(var(--fo-a));letter-spacing:.04em}.fp-about-title{margin-top:14px;font-size:30px;font-weight:800;letter-spacing:-.02em;line-height:1.25;color:rgba(var(--color-text))}.fp-about-title span{color:hsl(var(--fo-a))}.fp-about-tag{margin-top:14px;font-size:16px;line-height:1.7;color:rgba(var(--color-textSecondary))}.fp-about-story{margin-top:24px;display:flex;flex-direction:column;gap:8px}.fp-about-story p{font-size:15px;line-height:1.8;color:rgba(var(--color-textSecondary))}.fp-about-divider{margin:36px 0 20px;display:flex;align-items:center;gap:12px;color:rgba(var(--color-textTertiary));font-size:13px;font-weight:600;white-space:nowrap}.fp-about-divider::before,.fp-about-divider::after{content:'';height:1px;flex:1;background:rgba(var(--color-fillTertiary))}.fp-about-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.fp-about-card{padding:18px;border:1px solid rgba(var(--color-fillTertiary));border-radius:16px;background:rgba(var(--color-fillQuaternary));transition:border-color .2s ease,box-shadow .2s ease}.fp-about-card:hover{border-color:hsl(var(--fo-a) / .3);box-shadow:0 4px 16px hsl(var(--fo-a) / .06)}.fp-about-card-h{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;color:rgba(var(--color-text))}.fp-about-dot{width:8px;height:8px;border-radius:50%;background:hsl(var(--fo-a));flex:0 0 8px}.fp-about-card-p{margin-top:8px;font-size:13px;line-height:1.65;color:rgba(var(--color-textSecondary))}.fp-about-foot{margin-top:40px;text-align:center;font-size:12px;color:rgba(var(--color-textTertiary))}.fp-about-qr{margin-top:36px;display:flex;flex-direction:column;align-items:center;gap:14px;padding:28px 20px;border:1px solid rgba(var(--color-fillTertiary));border-radius:18px;background:rgba(var(--color-fillQuaternary))}.fp-about-qr-img{width:168px;height:168px;border-radius:12px;background:#fff;padding:10px;box-shadow:0 2px 12px rgba(0,0,0,.08)}.fp-about-qr-cap{font-size:14px;font-weight:650;color:rgba(var(--color-text))}.fp-about-qr-sub{font-size:12px;color:rgba(var(--color-textTertiary))}@media(max-width:520px){.fp-about-grid{grid-template-columns:1fr}.fp-about{padding:32px 18px 48px}.fp-about-title{font-size:26px}}
.fp-form{margin-top:8px;display:flex;flex-direction:column;gap:14px}.fp-field{display:flex;flex-direction:column;gap:6px}.fp-field label{font-size:13px;font-weight:650;color:rgba(var(--color-text))}.fp-field label span{color:hsl(var(--fo-a))}.fp-input,.fp-select,.fp-textarea{width:100%;padding:10px 12px;font-size:14px;color:rgba(var(--color-text));background:rgba(var(--color-fillQuaternary));border:1px solid rgba(var(--color-fillTertiary));border-radius:10px;outline:none;transition:border-color .2s ease,box-shadow .2s ease;font-family:inherit}.fp-textarea{min-height:84px;resize:vertical;line-height:1.6}.fp-input:focus,.fp-select:focus,.fp-textarea:focus{border-color:hsl(var(--fo-a) / .5);box-shadow:0 0 0 3px hsl(var(--fo-a) / .1)}.fp-form-btn{align-self:flex-start;margin-top:2px;padding:10px 22px;font-size:14px;font-weight:700;color:#fff;background:hsl(var(--fo-a));border:0;border-radius:10px;cursor:pointer;transition:opacity .2s ease,transform .1s ease}.fp-form-btn:hover{opacity:.9}.fp-form-btn:active{transform:translateY(1px)}.fp-form-btn:disabled{opacity:.5;cursor:default}.fp-form-msg{font-size:13px;line-height:1.6;min-height:18px;color:rgba(var(--color-textSecondary))}.fp-form-msg.ok{color:hsl(var(--fo-a))}.fp-form-msg.err{color:#e5484d}.fp-steps{margin-top:18px;display:flex;gap:10px;flex-wrap:wrap}.fp-step{flex:1;min-width:150px;display:flex;align-items:center;gap:10px;padding:12px 14px;border:1px solid rgba(var(--color-fillTertiary));border-radius:12px;background:rgba(var(--color-fillQuaternary))}.fp-step-n{flex:0 0 24px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:hsl(var(--fo-a) / .12);color:hsl(var(--fo-a));font-size:13px;font-weight:700}.fp-step-t{font-size:13px;line-height:1.4;color:rgba(var(--color-textSecondary))}@media(max-width:520px){.fp-step{min-width:100%}}
.fp-detail{display:none;position:fixed;inset:0;z-index:100;background:hsl(var(--background));overflow-y:auto;scrollbar-width:thin}
.fp-detail.open{display:block}
.fp-back{display:inline-flex;align-items:center;gap:6px;padding:14px 24px;font-size:14px;font-weight:600;color:hsl(var(--fo-a));cursor:pointer;border:0;background:transparent;position:sticky;top:0;z-index:10;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);background:hsl(var(--background) / .85)}
.fp-back:hover{opacity:.8}
.fp-back svg{width:18px;height:18px}
.fp-inner{max-width:720px;margin:0 auto;padding:0 24px 48px}
.fp-source{display:flex;align-items:center;gap:8px;margin-bottom:12px}.fp-source-icon{width:24px;height:24px;border-radius:8px;background:rgba(var(--color-fillSecondary));display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:rgba(var(--color-textTertiary));overflow:hidden}.fp-source-icon img{width:100%;height:100%;object-fit:cover}.fp-source-name{font-size:14px;font-weight:650;color:rgba(var(--color-text))}.fp-source-plat{font-size:12px;color:rgba(var(--color-textTertiary));padding:2px 8px;border-radius:4px;background:rgba(var(--color-fillSecondary))}
.fp-badges{display:flex;gap:6px;margin-bottom:14px}
.fp-title{font-size:24px;font-weight:780;line-height:1.34;color:rgba(var(--color-text));letter-spacing:-.02em;word-break:break-word;margin-bottom:10px}
.fp-title.long{font-size:18px;font-weight:680;line-height:1.5;letter-spacing:0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.fp-date{font-size:13px;color:rgba(var(--color-textTertiary));margin-bottom:24px;display:flex;align-items:center;gap:6px}
.fp-date svg{width:14px;height:14px;opacity:.5}
.fp-section{margin-top:24px;border-radius:12px;border:1px solid rgba(var(--color-fillTertiary));overflow:hidden}
.fp-section-head{display:flex;align-items:center;gap:8px;padding:14px 18px;font-size:13px;font-weight:700;color:hsl(var(--fo-a));border-bottom:1px solid rgba(var(--color-fillTertiary));background:linear-gradient(135deg,hsl(var(--fo-a) / .04),transparent 60%)}
.fp-section-head svg{width:16px;height:16px;flex-shrink:0}
.fp-section-body{padding:16px 18px;font-size:15px;line-height:1.78;color:rgba(var(--color-text));white-space:pre-wrap;word-break:break-word}
.fp-weibo-body{white-space:pre-wrap;line-height:1.85}
.fp-reason{margin-top:24px;border-radius:12px;border-left:3px solid #34d399;background:rgba(52,211,153,.06);padding:16px 18px}
.fp-reason-head{font-size:13px;font-weight:700;color:#047857;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.fp-reason-head svg{width:15px;height:15px}
.fp-reason-body{font-size:15px;line-height:1.72;color:rgba(var(--color-text))}
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
.fav-panel{margin:6px 8px 4px;background:hsl(var(--background));border:1px solid hsl(var(--border));border-radius:12px;padding:10px 12px}.fav-search-wrap{display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid hsl(var(--border));border-radius:9px;background:rgba(var(--color-fillTertiary))}.fav-search-wrap svg{width:15px;height:15px;color:rgba(var(--color-textTertiary));flex:0 0 auto}.fav-search{flex:1;min-width:0;border:0;outline:0;background:transparent;font-size:14px;color:rgba(var(--color-text))}.fav-results{margin-top:8px;display:flex;flex-direction:column;gap:3px;max-height:300px;overflow:auto}.fav-row{display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:8px}.fav-row:hover{background:rgba(var(--color-fillTertiary))}.fav-row-ico{width:22px;height:22px;border-radius:6px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;background:rgba(var(--color-fillSecondary));color:rgba(var(--color-textSecondary));overflow:hidden}.fav-row-ico img{width:100%;height:100%;object-fit:cover}.fav-row-name{flex:1;min-width:0;font-size:13.5px;color:rgba(var(--color-text));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fav-row-plat{font-size:11.5px;color:rgba(var(--color-textTertiary));flex:0 0 auto}.fav-star{flex:0 0 auto;border:1px solid hsl(var(--fo-a) / .4);background:transparent;color:hsl(var(--fo-a));font-size:12px;padding:3px 9px;border-radius:7px;cursor:pointer;white-space:nowrap;transition:all .15s}.fav-star.on{background:hsl(var(--fo-a));color:#fff;border-color:hsl(var(--fo-a))}.fav-hint{padding:16px 8px;font-size:13px;color:rgba(var(--color-textTertiary));text-align:center}.fav-note{margin-top:9px;padding:9px 11px;border-radius:9px;background:rgba(var(--color-fillTertiary));font-size:12.5px;line-height:1.6;color:rgba(var(--color-textSecondary))}.fav-note-link{color:hsl(var(--fo-a));cursor:pointer;font-weight:600}.fav-note-link:hover{text-decoration:underline}.fp-fav-btn{margin-left:auto;flex:0 0 auto;border:1px solid hsl(var(--fo-a) / .4);background:transparent;color:hsl(var(--fo-a));font-size:12px;padding:4px 11px;border-radius:8px;cursor:pointer;white-space:nowrap;transition:all .15s}.fp-fav-btn:hover{background:hsl(var(--fo-a) / .08)}.fp-fav-btn.on{background:hsl(var(--fo-a));color:#fff;border-color:hsl(var(--fo-a))}.fav-add-trigger{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;padding:9px 12px;border:1px dashed hsl(var(--fo-a) / .45);border-radius:9px;background:transparent;color:hsl(var(--fo-a));font-size:13.5px;font-weight:600;cursor:pointer;transition:all .15s}.fav-add-trigger:hover{background:hsl(var(--fo-a) / .07)}.fav-add-trigger svg{width:15px;height:15px;flex:0 0 auto}.fav-search-close{flex:0 0 auto;border:0;background:transparent;color:rgba(var(--color-textTertiary));font-size:12px;cursor:pointer;padding:2px 4px;white-space:nowrap}.fav-search-close:hover{color:rgba(var(--color-text))}.fav-card-star{flex:0 0 auto;border:0;background:transparent;color:rgba(var(--color-textTertiary));font-size:15px;line-height:1;cursor:pointer;padding:2px 4px;transition:color .15s}.fav-card-star:hover{color:hsl(var(--fo-a))}.fav-card-star.on{color:hsl(var(--fo-a))}
</style>
</head>
<body>
<div class="app">
<button class="mobile-toggle" id="mobile-toggle" aria-label="菜单"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button>
<aside class="sidebar" id="sidebar">
  <div class="brand">
    <div class="brand-main"><div class="brand-mark"><img src="data:image/png;base64,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" alt="FinHot"></div><div class="brand-title">FinHot</div><div class="brand-sub">金融动态聚合</div></div>
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
      <button class="tool-btn" id="obs-gear" data-obsidian-settings title="保存到 Obsidian 设置"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3 2.3 1.3 2.6-.3 1.2 2.4 2.4 1.2-.3 2.6L23.2 14l-1.3 2.3.3 2.6-2.4 1.2-1.2 2.4-2.6-.3L12 25l-2.3-1.3-2.6.3-1.2-2.4-2.4-1.2.3-2.6L.8 14l1.3-2.3-.3-2.6 2.4-1.2L5.4 5.4l2.6.3z" transform="scale(0.9) translate(1.2 -1)"/><circle cx="12" cy="12" r="3.2"/></svg></button>
    </div>
  </div>
  <div class="tabs" id="tabs"></div>
  <div class="content-area" id="content-area">
    <div class="entry-list" id="entry-list"></div>
    <aside class="detail-panel" id="detail-panel"></aside>
    <div class="obs-modal" id="obs-modal"><div class="obs-dialog"><div class="obs-dialog-head"><span>保存到 Obsidian</span><button class="obs-x" id="obs-close" title="关闭">✕</button></div><div class="obs-field"><label>Local REST API 地址</label><input id="obs-endpoint" placeholder="https://127.0.0.1:27124"></div><div class="obs-field"><label>API Key</label><input id="obs-token" type="password" placeholder="Obsidian 插件中的 API Key"></div><div class="obs-field"><label>目标文件夹（可选）</label><input id="obs-folder" placeholder="如 Clippings，留空=库根目录"></div><div class="obs-hint">需在 Obsidian 安装 <b>Local REST API</b> 社区插件并复制 API Key；自签证书需先在浏览器信任 <b>https://127.0.0.1:27124</b>（或使用插件的 http 端口）。配置仅保存在本浏览器，不经服务器。</div><div class="obs-actions"><button class="obs-btn-ghost" id="obs-cancel">取消</button><button class="obs-btn" id="obs-save">保存</button></div></div></div>
    <div class="obs-toast" id="obs-toast"></div>
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
var favKey="finhot-fav-feeds";var favFeeds={};var favQuery="";var favSearchOpen=false;
function loadFav(){try{var a=JSON.parse(localStorage.getItem(favKey)||"[]");favFeeds={};if(Array.isArray(a))a.forEach(function(id){favFeeds[String(id)]=1})}catch(e){favFeeds={}}}
function saveFav(){try{localStorage.setItem(favKey,JSON.stringify(Object.keys(favFeeds)))}catch(e){}}
function isFav(id){return !!favFeeds[id]}
function toggleFav(id){if(favFeeds[id])delete favFeeds[id];else favFeeds[id]=1;saveFav()}

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
function articleHtml(s,hl){if(!s)return"";var t=esc(String(s).trim()).replace(/\\n{3,}/g,"\\n\\n");if(t.indexOf("\\n")<0){var _sn=t.match(/[^\\u3002\\uff01\\uff1f!?\\n]+[\\u3002\\uff01\\uff1f!?]+/g);if(_sn&&_sn.length>=3){t="";for(var _k=0;_k<_sn.length;_k++){t+=_sn[_k];if((_k+1)%2===0&&_k<_sn.length-1)t+="\\n\\n"}}}t=t.replace(/([^\\n])([\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341]+\\u3001)/g,"$1\\n$2");t=t.replace(/([^\\n\\u3001])(\\d+\\u3001)/g,"$1\\n$2");t=t.replace(/([^\\n])(No\\.\\d+)/gi,"$1\\n$2");var lines=t.split(/\\n/);var out="";var ul=0;for(var i=0;i<lines.length;i++){var ln=lines[i].trim();if(!ln){if(ul){out+="</ul>";ul=0}continue}if(/^[\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341]+[\\u3001.]/.test(ln)){if(ul){out+="</ul>";ul=0}out+="<h3>"+artHL(ln,hl)+"</h3>";continue}if(/^[\\uff08(][\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341]+[\\uff09)]/.test(ln)){if(ul){out+="</ul>";ul=0}out+="<h4>"+artHL(ln,hl)+"</h4>";continue}if(/^No\\.\\d+$/i.test(ln)){if(ul){out+="</ul>";ul=0}out+='<span class="art-sep">'+ln+'</span>';continue}if(/^\\d{1,2}\\u3001/.test(ln)){if(!ul){out+="<ul>";ul=1}out+="<li>"+artHL(ln.replace(/^\\d{1,2}\\u3001\\s*/,""),hl)+"</li>";continue}if(/^[\\xb7\\u2022\\-]\\s/.test(ln)){if(!ul){out+="<ul>";ul=1}out+="<li>"+artHL(ln.replace(/^[\\xb7\\u2022\\-]\\s+/,""),hl)+"</li>";continue}if(ul){out+="</ul>";ul=0}out+="<p>"+artHL(ln,hl)+"</p>"}if(ul)out+="</ul>";return out}
function artHL(s,hl){var ex=[];if(hl&&hl.length){for(var _i=0;_i<hl.length;_i++){var _t=String(typeof hl[_i]==="object"?(hl[_i].label||hl[_i].name||""):(hl[_i]||"")).trim();if(_t.length>=2&&!/[.*+?^|(){}\\[\\]\\\\]/.test(_t)&&ex.indexOf(_t)<0)ex.push(_t)}}ex.sort(function(a,b){return b.length-a.length});var alt=ex.join("|");var re=new RegExp("==([^=]+)==|《([^》]+)》|【([^】]+)】"+(alt?"|("+alt+")":""),"g");return s.replace(re,function(m,a,b,c,d){if(a!=null)return"<mark>"+a+"</mark>";if(b!=null)return"<strong>《"+b+"》</strong>";if(c!=null)return"<strong>【"+c+"】</strong>";if(d!=null)return'<mark class="hl-tag">'+d+"</mark>";return m})}
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
  var rawBody=stripNL(e.content||e.description||"").trim();
  var bodyText=strip(e.content||e.description||"").replace(/\\s+/g," ").trim();
  var titleText=String(e.title||"(\u65E0\u6807\u9898)").trim();
  var isLongTitle=plain(titleText).length>90;
  var source=(p==="weibo")?{text:rawBody,note:""}:sourceBody(titleText,bodyText);
  var h='<div class="detail-header">';
  h+='<button class="detail-close-btn" id="detail-close" title="\u5173\u95ED"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button>';
  h+='<span class="detail-header-title">'+esc(titleText)+"</span>";
  h+='<div class="detail-header-tools">';
  h+='<button data-obsidian-save="'+esc(e.id)+'" title="保存原文到 Obsidian"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg></button>';
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
    if(summary)h+='<div class="detail-ai-body">'+articleHtml(summary,en.tags||[])+'</div>';
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
  var rawBody=stripNL(e.content||e.description||"").trim();
  var bodyText=(p==="weibo")?rawBody:stripNL(e.content||e.description||"").replace(/[ \\t\\r]+/g," ").trim();
  var titleText=strip(e.title||"").replace(/\\s+/g," ").trim();
  if(!titleText){var _src=f.title||"";var _auth=e.author||"";if(_auth&&_src&&_auth!==_src&&_src.indexOf(_auth)===-1){titleText=_src+" \u00B7 "+_auth}else{titleText=_src||_auth||"(\u65E0\u6807\u9898)"}}
  var bodyHtml=(p==="weibo")?textHtml(rawBody):articleHtml(bodyText,en.tags||[]);
  var pd=new Date(e.publishedAt);
  var dateStr=isFinite(pd.getTime())?(pd.getFullYear()+"\u5E74"+(pd.getMonth()+1)+"\u6708"+pd.getDate()+"\u65E5 "+String(pd.getHours()).padStart(2,"0")+":"+String(pd.getMinutes()).padStart(2,"0")):"";
  var h='<button class="fp-back" id="fp-back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>\u8FD4\u56DE</button>';
  h+='<div class="fp-inner">';
  h+='<div class="fp-source"><span class="fp-source-icon">'+(f.image?'<img src="'+esc(f.image)+'" alt="">':esc(initial(f.title||f.url)))+'</span><span class="fp-source-name">'+esc(f.title||f.url||"")+'</span><span class="fp-source-plat">'+esc(pLabel)+'</span><button class="fp-fav-btn '+(isFav(e.feedId)?"on":"")+'" data-fav-toggle="'+esc(e.feedId)+'">'+(isFav(e.feedId)?"\u5DF2\u81EA\u9009 \u2605":"\u52A0\u5165\u81EA\u9009 \u2606")+'</button></div>';
  if(sl||score!=null){h+='<div class="fp-badges">';if(sl)h+='<span class="q q-'+scoreTier(score||0)+'">'+esc(sl)+'</span>';if(score!=null)h+='<span class="q q-'+scoreTier(score)+'">'+score+'</span>';h+='</div>'}
  var isLongTitle=plain(titleText).length>90;
  h+='<h1 class="fp-title'+(isLongTitle?" long":"")+'">'+esc(titleText)+'</h1>';
  h+='<div class="fp-date"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>'+esc(dateStr)+(dateStr?" \u00B7 ":"")+esc(when(e.publishedAt))+'</div>';
  if(reason){h+='<div class="fp-reason"><div class="fp-reason-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.7 5.8 21 7 14.2 2 9.3l6.9-1z"/></svg>\u7CBE\u9009\u7406\u7531</div><div class="fp-reason-body">'+textHtml(reason)+'</div></div>'}
  if(summary){h+='<div class="fp-section"><div class="fp-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z"/></svg>AI \u6458\u8981</div><div class="fp-section-body">'+articleHtml(summary,en.tags||[])+'</div></div>'}
  if(hasTranslation(en)){
    h+='<div class="fp-section"><div class="fp-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>AI \u7FFB\u8BD1 \u00B7 \u4E2D\u6587</div><div class="fp-section-body" id="fp-trans-body">';
    if(tr.title)h+='<div style="font-weight:660;margin-bottom:8px">'+textHtml(tr.title)+'</div>';
    if(translatedBody)h+=textHtml(translatedBody);
    h+='</div></div>';
    if(bodyText){h+='<div class="fp-section"><div class="fp-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>\u539F\u6587</div><div class="fp-section-body'+(p==="weibo"?" fp-weibo-body":" fp-article")+'">'+bodyHtml+'</div></div>'}
  } else if(bodyText){
    h+='<div class="fp-section"><div class="fp-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>\u539F\u6587</div><div class="fp-section-body'+(p==="weibo"?" fp-weibo-body":" fp-article")+'">'+bodyHtml+'</div></div>';
  }
  if(e.url){h+='<a class="fp-orig-link" href="'+esc(e.url)+'" target="_blank" rel="noopener">\u6253\u5F00\u539F\u6587 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg></a>'}
  h+='</div>';
  fp.innerHTML=h;fp.scrollTop=0;fp.classList.add("open");
  document.getElementById("fp-back").addEventListener("click",function(){showFullDetail(null)});
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
  h+='</div><div class="ai-body">'+(summary?articleHtml(summary,en.tags||[]):'暂无 AI 总结')+'</div>';
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
var SCORE_GATE=25;
var WHITEBOX_PATTERNS=${JSON.stringify(WHITEBOX_FEED_PATTERNS)};
function isWhiteboxFeed(f){if(!f||!WHITEBOX_PATTERNS.length)return false;var hay=((f.url||"")+"\\n"+(f.category||"")).toLowerCase();for(var i=0;i<WHITEBOX_PATTERNS.length;i++){if(hay.indexOf(WHITEBOX_PATTERNS[i])>=0)return true}return false}
// Primary subscribed accounts (wechat/xueqiu/twitter/weibo) are already curated
// server-side (recency + score gate + per-feed cap), so the client shows them all.
// Whitebox feeds (e.g. cninfo L3 candidates) are shown raw, bypassing the gate.
// Only generic discovery RSS still needs the in-page score gate.
function passesScoreGate(e){var f=feedMap[e.feedId];if(isWhiteboxFeed(f))return true;var p=platform(f);if(p!=="other")return true;var v=scoreVal(enrichments[e.id]);return v!=null&&v>=SCORE_GATE}
function visibleByCat(e){if(activeCat==="all")return true;return platform(feedMap[e.feedId])===activeCat}
function isToday(e){var d=new Date(e.publishedAt);var n=new Date();return d.toDateString()===n.toDateString()}
function countForFeed(id){return (entriesByFeed[id]||[]).length}
function icon(name){var icons={today:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2v4M16 2v4M3 10h18"/><rect x="3" y="4" width="18" height="18" rx="2"/></svg>',unread:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h6"/></svg>',star:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.3L5.8 21 7 14.2 2 9.3l6.9-1z"/></svg>',radar:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20a8 8 0 1 0-8-8"/><path d="M12 16a4 4 0 1 0-4-4"/><path d="M12 12 4 20"/></svg>',fav:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>'};return icons[name]||""}

var radarTopics=buildRadarTopics();
var hasSelected=allEntries.some(function(e){return selStatus(enrichments[e.id])==="selected"});
if(hasSelected)activeView="smart-selected";
else if(allEntries.some(isToday))activeView="smart-today";
else activeView="smart-selected";

function renderSmartNav(){
  var todayCount=allEntries.filter(function(e){return isToday(e)&&passesScoreGate(e)}).length;
  var selectedCount=allEntries.filter(function(e){return selStatus(enrichments[e.id])==="selected"||platform(feedMap[e.feedId])!=="other"}).length;
  var items=[
    {id:"smart-selected",label:"\u7CBE\u9009",count:selectedCount,ico:"star"},
    {id:"smart-fav",label:"\u81EA\u9009",count:Object.keys(favFeeds).length,ico:"fav"},
    {id:"smart-today",label:"\u4ECA\u5929",count:todayCount,ico:"today"},
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
  if(activeView==="smart-fav"){list=allEntries.filter(function(e){return isFav(e.feedId)})}
  else if(activeCat!=="all"){list=allEntries.slice();if(activeCat!=="wechat")list=list.filter(passesScoreGate)}
  else if(activeView==="smart-selected")list=allEntries.filter(function(e){return selStatus(enrichments[e.id])==="selected"||platform(feedMap[e.feedId])!=="other"});
  else if(activeView==="smart-today")list=allEntries.filter(function(e){return isToday(e)&&passesScoreGate(e)});
  else list=allEntries.filter(passesScoreGate);
  return list.filter(visibleByCat).sort(function(a,b){return new Date(b.publishedAt).getTime()-new Date(a.publishedAt).getTime()});
}

function render(){
  renderSmartNav();
  var isInfo=activeView==="about"||activeView==="feedback";
  document.querySelectorAll('[data-view="about"],[data-view="feedback"]').forEach(function(b){b.classList.toggle("active",b.getAttribute("data-view")===activeView)});
  var tabsEl=document.getElementById("tabs");if(tabsEl)tabsEl.style.display=isInfo?"none":"";
  if(activeView==="about"){renderAbout();return}
  if(activeView==="feedback"){renderFeedback();return}
  renderTabs();
  if(activeView==="smart-radar"){renderRadar();return}
  if(activeView==="smart-fav"){renderFav();return}
  renderTimeline();
}

function renderAbout(){
  header("\u5173\u4E8E","FinHot \u00B7 \u91D1\u878D\u70ED\u8BCD\u96F7\u8FBE");
  var feats=[
    ["\u591A\u6E90\u91C7\u96C6","RSS \u8D22\u7ECF\u5FEB\u8BAF + \u5FAE\u535A / \u96EA\u7403 / \u516C\u4F17\u53F7 watchlist\uFF0C\u4E00\u5904\u6C47\u603B\u3002"],
    ["\u70ED\u8BCD\u5F15\u64CE","\u5206\u8BCD + \u7A81\u53D1\u68C0\u6D4B + \u70ED\u5EA6\u8BC4\u5206\uFF0C\u7B2C\u4E00\u65F6\u95F4\u53D1\u73B0\u65B0\u52A8\u9759\u3002"],
    ["\u7092\u4F5C\u6D53\u5EA6","\u81EA\u52A8\u6807\u6CE8\u542B\u7092\u4F5C\u4FE1\u53F7\u7684 A \u80A1\u70ED\u8BCD\uFF0C\u8BC6\u522B\u566A\u58F0\u3002"],
    ["\u91D1\u878D\u7B80\u62A5","AI \u5E2E\u4F60\u7B5B\u6389\u566A\u58F0\uFF0C\u628A\u771F\u6B63\u503C\u5F97\u770B\u7684\u51E0\u6761\u7559\u4E0B\u6765\u3002"]
  ];
  var cards=feats.map(function(f){return '<div class="fp-about-card"><div class="fp-about-card-h"><span class="fp-about-dot"></span>'+esc(f[0])+'</div><div class="fp-about-card-p">'+esc(f[1])+'</div></div>'}).join("");
  var h='<div class="fp-about">'
    +'<div class="fp-about-eyebrow">\u5173\u4E8E\u8FD9\u4E2A\u7AD9</div>'
    +'<h1 class="fp-about-title">FinHot \u00B7 <span>\u91D1\u878D\u70ED\u8BCD\u96F7\u8FBE</span></h1>'
    +'<p class="fp-about-tag">\u672C\u5730\u4F18\u5148\u7684\u91D1\u878D\u4FE1\u606F\u76D1\u63A7\u5E73\u53F0\uFF0C\u514D\u8D39\u5F00\u653E\u7ED9\u5927\u5BB6\u7528\u3002</p>'
    +'<div class="fp-about-story"><p>\u6BCF\u5929\u76EF\u7740\u8D22\u7ECF\u5FEB\u8BAF\u91CC\u7684\u7A81\u53D1\u70ED\u8BCD\u3002</p><p>\u7528 AI \u5E2E\u4F60\u7B5B\u6389\u566A\u58F0\u3002</p><p>\u628A\u771F\u6B63\u503C\u5F97\u770B\u7684\u51E0\u6761\u7559\u4E0B\u6765\u3002</p></div>'
    +'<div class="fp-about-divider">\u5B83\u80FD\u505A\u4EC0\u4E48</div>'
    +'<div class="fp-about-grid">'+cards+'</div>'
    +'<div class="fp-about-qr">'+'<img class="fp-about-qr-img" alt="DeepFomo \u516C\u4F17\u53F7" src="data:image/png;base64,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"/>'+'<div class="fp-about-qr-cap">\u626B\u7801\u5173\u6CE8\u516C\u4F17\u53F7 DeepFomo</div>'+'<div class="fp-about-qr-sub">\u83B7\u53D6\u66F4\u591A\u91D1\u878D\u4FE1\u606F\u4E0E\u66F4\u65B0</div>'+'</div>'
    +'<div class="fp-about-foot">\u7528\u5FC3\u505A\u7684\u5C0F\u9879\u76EE \u00B7 since 2026</div>'
    +'</div>';
  var list=document.getElementById("entry-list");list.innerHTML=h;list.scrollTop=0;
}

function renderFeedback(){
  header("\u6295\u7A3F\u4FE1\u6E90","\u8BA9\u96F7\u8FBE\u8986\u76D6\u66F4\u591A\u4F60\u5173\u5FC3\u7684\u4FE1\u6E90");
  var plats=["\u516C\u4F17\u53F7","\u5FAE\u535A","\u96EA\u7403","X / \u63A8\u7279","RSS / \u7F51\u7AD9","\u5176\u4ED6"];
  var opts=plats.map(function(p){return '<option value="'+esc(p)+'">'+esc(p)+'</option>'}).join("");
  var steps=[["1","\u63D0\u4EA4\u4F60\u60F3\u8BA2\u9605\u7684\u8D22\u7ECF\u4FE1\u6E90"],["2","\u6211\u4EEC\u6536\u5230\u540E\u4EBA\u5DE5\u5BA1\u6838"],["3","\u901A\u8FC7\u540E\u52A0\u5165\uFF0C\u5168\u7AD9\u53EF\u8BA2\u9605"]];
  var stepsHtml=steps.map(function(s){return '<div class="fp-step"><span class="fp-step-n">'+s[0]+'</span><span class="fp-step-t">'+esc(s[1])+'</span></div>'}).join("");
  var h='<div class="fp-about">'
    +'<div class="fp-about-eyebrow">\u6295\u7A3F\u4FE1\u6E90</div>'
    +'<h1 class="fp-about-title">\u60F3\u770B\u7684\u4FE1\u6E90\uFF0C<span>\u544A\u8BC9\u6211\u4EEC</span></h1>'
    +'<p class="fp-about-tag">\u9009\u597D\u5E73\u53F0\uFF0C\u586B\u4E0A\u4F60\u60F3\u8BA2\u9605\u7684\u8D22\u7ECF\u4FE1\u6E90 ID \u6216\u94FE\u63A5\uFF0C\u6211\u4EEC\u5BA1\u6838\u540E\u52A0\u8FDB\u6765\u3002</p>'
    +'<div class="fp-steps">'+stepsHtml+'</div>'
    +'<div class="fp-about-divider">\u6295\u7A3F\u8868\u5355</div>'
    +'<div class="fp-form">'
    +'<div class="fp-field"><label>\u5E73\u53F0</label><select id="fp-fs-platform" class="fp-select">'+opts+'</select></div>'
    +'<div class="fp-field"><label>\u4FE1\u6E90 ID / \u94FE\u63A5 <span>*</span></label><input id="fp-fs-id" class="fp-input" maxlength="500" placeholder="\u5FAE\u535A UID / \u96EA\u7403\u7528\u6237 ID / \u516C\u4F17\u53F7\u540D / RSS \u94FE\u63A5"></div>'
    +'<button id="fp-fs-btn" class="fp-form-btn">\u63D0\u4EA4</button>'
    +'<div id="fp-fs-msg" class="fp-form-msg"></div>'
    +'</div>'
    +'<div class="fp-about-foot">\u611F\u8C22\u4F60\u5E2E FinHot \u53D8\u5F97\u66F4\u5168</div>'
    +'</div>';
  var list=document.getElementById("entry-list");list.innerHTML=h;list.scrollTop=0;
  var btn=document.getElementById("fp-fs-btn");if(btn)btn.addEventListener("click",submitFeedSuggestion);
}

function submitFeedSuggestion(){
  var idEl=document.getElementById("fp-fs-id");
  var msg=document.getElementById("fp-fs-msg");
  var btn=document.getElementById("fp-fs-btn");
  var id=((idEl&&idEl.value)||"").trim();
  if(!id){msg.className="fp-form-msg err";msg.textContent="\u8BF7\u5148\u586B\u5199\u4FE1\u6E90 ID \u6216\u94FE\u63A5\u3002";if(idEl)idEl.focus();return}
  var payload={
    id:id,
    platform:(((document.getElementById("fp-fs-platform")||{}).value)||"").trim()
  };
  btn.disabled=true;msg.className="fp-form-msg";msg.textContent="\u63D0\u4EA4\u4E2D\u2026";
  fetch(${JSON.stringify(FEED_SUGGESTION_PUBLIC_API_BASE)}+"/api/public/feed-suggestion",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)})
    .then(function(r){if(!r.ok)throw new Error("bad status");return r.json()})
    .then(function(){msg.className="fp-form-msg ok";msg.textContent="\u6536\u5230\uFF0C\u8C22\u8C22\u4F60\u7684\u6295\u7A3F\uFF01\u6211\u4EEC\u4F1A\u5C3D\u5FEB\u5BA1\u6838\u3002";if(idEl)idEl.value=""})
    .catch(function(){
      var text="\u3010FinHot \u4FE1\u6E90\u6295\u7A3F\u3011\\n\u5E73\u53F0\uFF1A"+(payload.platform||"-")+"\\nID/\u94FE\u63A5\uFF1A"+payload.id;
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(function(){msg.className="fp-form-msg ok";msg.textContent="\u5F53\u524D\u672A\u63A5\u5165\u63D0\u4EA4\u901A\u9053\uFF0C\u5DF2\u628A\u5185\u5BB9\u590D\u5236\u5230\u526A\u8D34\u677F\uFF0C\u8BF7\u53D1\u7ED9\u6211\u4EEC\u3002"}).catch(function(){msg.className="fp-form-msg err";msg.textContent="\u63D0\u4EA4\u901A\u9053\u6682\u672A\u63A5\u5165\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002"})}
      else{msg.className="fp-form-msg err";msg.textContent="\u63D0\u4EA4\u901A\u9053\u6682\u672A\u63A5\u5165\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002"}
    })
    .then(function(){btn.disabled=false});
}

function header(title,sub){document.getElementById("header-title").textContent=title;document.getElementById("header-sub").textContent=sub||""}
function empty(msg,sub){document.getElementById("entry-list").innerHTML='<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M9 12h6"/></svg><div>'+esc(msg)+'</div>'+(sub?'<div>'+esc(sub)+'</div>':"")+'</div>'}

function renderTimeline(){
  var entries=selectedEntries();
  var title=activeView==="smart-selected"?"\u7CBE\u9009":activeView==="smart-today"?"\u4ECA\u5929":"\u5168\u90E8";
  header(title,entries.length+" \u6761\u5185\u5bb9 \u00b7 "+feeds.length+" \u4e2a\u4fe1\u6e90");
  if(!entries.length){empty("暂无内容",activeView==="smart-today"?"今天当前筛选下没有内容":"");return}
  var list=document.getElementById("entry-list");list.innerHTML=buildTimelineHtml(entries);list.scrollTop=0;
}
function buildTimelineHtml(entries){
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
  return html;
}

function feedPlatLabel(f){return platformLabel(platform(f))}
function favEntries(){return allEntries.filter(function(e){return isFav(e.feedId)}).filter(visibleByCat).sort(function(a,b){return new Date(b.publishedAt).getTime()-new Date(a.publishedAt).getTime()})}
function renderFav(){
  header("\u81EA\u9009",Object.keys(favFeeds).length+" \u4E2A\u4FE1\u6E90 \u00B7 "+favEntries().length+" \u6761\u5185\u5BB9");
  var searchInner=favSearchOpen
    ?'<div class="fav-search-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><input id="fav-search" class="fav-search" placeholder="\u641C\u7D22\u7AD9\u5185\u4FE1\u6E90\uFF0C\u52A0\u5165\u81EA\u9009\u2026" value="'+esc(favQuery)+'"><button class="fav-search-close" data-fav-search-toggle>\u6536\u8D77</button></div><div id="fav-results" class="fav-results"></div>'
    :'<button class="fav-add-trigger" data-fav-search-toggle><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>\u641C\u7D22\u7AD9\u5185\u4FE1\u6E90\u52A0\u5165\u81EA\u9009</button>';
  var h='<div class="fav-panel">'+searchInner+'<div class="fav-note">\u641C\u7D22\u7AD9\u5185\u4FE1\u6E90\u52A0\u5165\u81EA\u9009\uFF0C\u53EA\u770B\u4F60\u5173\u5FC3\u7684\u90A3\u51E0\u4E2A\uFF1B\u9009\u62E9\u4FDD\u5B58\u5728\u672C\u5730\u6D4F\u89C8\u5668\uFF0C\u4E0D\u9700\u8981\u767B\u5F55\u3002\u7AD9\u5185\u6CA1\u6709\u7684\u4FE1\u6E90\uFF1F\u53BB <a class="fav-note-link" data-view="feedback">\u53CD\u9988</a> \u6295\u7A3F\uFF0C\u6211\u4EEC\u770B\u5230\u540E\u4F1A\u6DFB\u52A0\u8FDB\u7AD9\u3002</div></div><div id="fav-timeline"></div>';
  var list=document.getElementById("entry-list");list.innerHTML=h;list.scrollTop=0;
  var inp=document.getElementById("fav-search");if(inp){inp.addEventListener("input",function(){favQuery=inp.value;renderFavResults()});inp.focus()}
  if(favSearchOpen)renderFavResults();
  renderFavTimeline();
}
function renderFavResults(){
  var box=document.getElementById("fav-results");if(!box)return;
  var q=favQuery.trim().toLowerCase();var matches;
  if(!q){matches=feeds.filter(function(f){return isFav(f.id)})}
  else{matches=feeds.filter(function(f){var name=(f.title||f.url||"").toLowerCase();var pl=feedPlatLabel(f).toLowerCase();return name.indexOf(q)>=0||pl.indexOf(q)>=0})}
  if(!matches.length){box.innerHTML='<div class="fav-hint">'+(q?"\u6CA1\u6709\u5339\u914D\u7684\u4FE1\u6E90":"\u8FD8\u6CA1\u6709\u81EA\u9009\u4FE1\u6E90\uFF0C\u4E0A\u65B9\u641C\u7D22\u540E\u70B9\u201C\u52A0\u5165\u201D\u6DFB\u52A0")+'</div>';return}
  box.innerHTML=matches.slice(0,40).map(function(f){var on=isFav(f.id);return '<div class="fav-row"><span class="fav-row-ico">'+(f.image?'<img src="'+esc(f.image)+'" alt="">':esc(initial(f.title||f.url)))+'</span><span class="fav-row-name">'+esc(f.title||f.url||"")+'</span><span class="fav-row-plat">'+esc(feedPlatLabel(f))+'</span><button class="fav-star '+(on?"on":"")+'" data-fav-toggle="'+esc(f.id)+'">'+(on?"\u5DF2\u81EA\u9009 \u2605":"\u52A0\u5165 \u2606")+'</button></div>'}).join("");
}
function renderFavTimeline(){
  var box=document.getElementById("fav-timeline");if(!box)return;
  var entries=favEntries();
  if(!entries.length){box.innerHTML='<div class="empty" style="padding:30px 0"><div>'+(Object.keys(favFeeds).length?"\u8BE5\u7B5B\u9009\u4E0B\u6682\u65E0\u5185\u5BB9":"\u8FD8\u6CA1\u6709\u81EA\u9009\u4FE1\u6E90")+'</div><div>\u5728\u4E0A\u65B9\u641C\u7D22\u5E76\u52A0\u5165\u4F60\u60F3\u5173\u6CE8\u7684\u4FE1\u6E90</div></div>';return}
  box.innerHTML=buildTimelineHtml(entries);
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
  h+='<button class="fav-card-star '+(isFav(e.feedId)?"on":"")+'" data-fav-toggle="'+esc(e.feedId)+'" title="\u52A0\u5165\u81EA\u9009">'+(isFav(e.feedId)?"\u2605":"\u2606")+'</button>';
  h+='</div>';
  h+='<button class="card-title" data-open-entry="'+esc(e.id)+'">'+esc(displayTitle)+'</button>';
  if(desc){h+='<div class="desc">'+esc(desc)+'</div>'}
  var foot="";
  if(tags.length)foot+='<div class="tags">'+tags.map(function(t){return '<span class="tag'+tagColorClass(t)+'">'+esc(typeof t==="object"?(t.label||t.name||""):t)+'</span>'}).join("")+'</div>';
  if(cl.leaders[e.id])foot+='<button class="cluster '+(expandedClusters[e.id]?"on":"")+'" data-cluster="'+esc(e.id)+'">+'+(cl.leaders[e.id].length-1)+' 相关</button>';
  if(foot)h+='<div class="card-foot">'+foot+'</div>';
  var plat=platform(f);
  if(reason&&plat!=="wechat"){h+='<div class="card-reason">\u63A8\u8350\u7406\u7531\uFF1A'+esc(reason)+'</div>'}
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
  h+='<div class="radar-entries">'+t.entryIds.slice(0,8).map(function(id){var e=allEntries.find(function(x){return x.id===id});if(!e)return"";var ren=enrichments[e.id]||{};var rsl=selLabel(ren);var f=feedMap[e.feedId]||{};return '<div class="radar-entry" data-open-entry="'+esc(e.id)+'"><span class="feed-dot" style="font-size:9px">'+esc(initial(f.title||f.url))+'</span><span class="radar-entry-title">'+esc(e.title||"(\u65E0\u6807\u9898)")+'</span>'+(rsl?'<span class="q q-'+((scoreVal(ren)||0)>=70?"high":"medium")+'" style="font-size:10px">'+esc(rsl)+'</span>':"")+'<span class="time">'+when(e.publishedAt)+'</span></div>'}).join("")+'</div></section>';
  return h;
}

document.addEventListener("click",function(ev){
  var obsSaveBtn=ev.target.closest("[data-obsidian-save]");if(obsSaveBtn){ev.preventDefault();ev.stopPropagation();saveEntryToObsidian(obsSaveBtn.getAttribute("data-obsidian-save"));return}
  var obsCfgBtn=ev.target.closest("[data-obsidian-settings]");if(obsCfgBtn){ev.preventDefault();openObsidianSettings();return}
  var favST=ev.target.closest("[data-fav-search-toggle]");if(favST){favSearchOpen=!favSearchOpen;if(!favSearchOpen)favQuery="";renderFav();return}
  var favT=ev.target.closest("[data-fav-toggle]");if(favT){ev.preventDefault();ev.stopPropagation();var ffid=favT.getAttribute("data-fav-toggle");toggleFav(ffid);renderSmartNav();if(activeView==="smart-fav"){favSearchOpen=false;favQuery="";renderFav()}else{var on=isFav(ffid);document.querySelectorAll("[data-fav-toggle]").forEach(function(b){if(b.getAttribute("data-fav-toggle")!==ffid)return;b.classList.toggle("on",on);if(b.classList.contains("fav-card-star"))b.textContent=on?"\u2605":"\u2606";else if(b.classList.contains("fp-fav-btn"))b.textContent=on?"\u5DF2\u81EA\u9009 \u2605":"\u52A0\u5165\u81EA\u9009 \u2606";else b.textContent=on?"\u5DF2\u81EA\u9009 \u2605":"\u52A0\u5165 \u2606"})}return}
  var view=ev.target.closest("[data-view]");if(view){activeView=view.getAttribute("data-view");activeEntryId=null;renderDetail(null);render();closeMobile();return}
  var tab=ev.target.closest("[data-cat]");if(tab&&tab.classList.contains("tab")){activeCat=tab.getAttribute("data-cat");activeEntryId=null;renderDetail(null);render();return}
  var dateToggle=ev.target.closest("[data-toggle-date]");if(dateToggle){var dt=dateToggle.getAttribute("data-toggle-date");collapsedDates[dt]=!collapsedDates[dt];renderTimeline();return}
  var cluster=ev.target.closest("[data-cluster]");if(cluster){var cid=cluster.getAttribute("data-cluster");expandedClusters[cid]=!expandedClusters[cid];renderTimeline();return}
  function openEntryDetail(eid){if(window.innerWidth>768){activeEntryId=eid;renderDetail(eid);renderTimeline();showFullDetail(null)}else{activeEntryId=null;renderDetail(null);showFullDetail(eid)}}
  var openEntry=ev.target.closest("[data-open-entry]");if(openEntry){openEntryDetail(openEntry.getAttribute("data-open-entry"));return}
  var card=ev.target.closest("[data-entry-card]");if(card&&!ev.target.closest("a,button,.q-wrap")){openEntryDetail(card.getAttribute("data-entry-card"));return}
  var topic=ev.target.closest("[data-topic]");if(topic){var tid=topic.getAttribute("data-topic");expandedTopicId=expandedTopicId===tid?null:tid;renderRadar();return}
});
function closeMobile(){if(window.innerWidth<=520){document.getElementById("sidebar").classList.remove("open");document.getElementById("overlay").classList.remove("open")}}
document.getElementById("mobile-toggle").addEventListener("click",function(){document.getElementById("sidebar").classList.toggle("open");document.getElementById("overlay").classList.toggle("open")});
document.getElementById("overlay").addEventListener("click",closeMobile);

(function(){var GAP=8,MARGIN=12;function tipOf(wrap){var tip=wrap.__fhTip;if(!tip){tip=wrap.querySelector(".q-detail");if(tip){document.body.appendChild(tip);wrap.__fhTip=tip}}return tip}function place(wrap){var tip=tipOf(wrap);if(!tip)return;tip.style.display="block";tip.style.left="-9999px";tip.style.top="0px";var r=wrap.getBoundingClientRect();var tw=tip.offsetWidth,th=tip.offsetHeight;var vw=document.documentElement.clientWidth,vh=document.documentElement.clientHeight;var left=r.right-tw;if(left+tw>vw-MARGIN)left=vw-MARGIN-tw;if(left<MARGIN)left=MARGIN;var top=r.bottom+GAP;if(top+th>vh-MARGIN){var above=r.top-GAP-th;top=above>=MARGIN?above:Math.max(MARGIN,vh-MARGIN-th)}tip.style.left=left+"px";tip.style.top=top+"px"}function hide(wrap){var tip=wrap.__fhTip;if(tip)tip.style.display="none"}document.addEventListener("mouseover",function(ev){var w=ev.target.closest(".q-wrap");if(w&&!w.contains(ev.relatedTarget))place(w)});document.addEventListener("mouseout",function(ev){var w=ev.target.closest(".q-wrap");if(w&&!w.contains(ev.relatedTarget))hide(w)});document.addEventListener("focusin",function(ev){var w=ev.target.closest(".q-wrap");if(w)place(w)});document.addEventListener("focusout",function(ev){var w=ev.target.closest(".q-wrap");if(w&&!w.contains(ev.relatedTarget))hide(w)});window.addEventListener("scroll",function(){document.querySelectorAll(".q-detail").forEach(function(t){t.style.display="none"})},true);window.addEventListener("resize",function(){document.querySelectorAll(".q-detail").forEach(function(t){t.style.display="none"})})})();

var themeKey="finhot-theme";
function applyTheme(t){if(t==="dark")document.documentElement.setAttribute("data-theme","dark");else if(t==="light")document.documentElement.setAttribute("data-theme","light");else document.documentElement.removeAttribute("data-theme");document.querySelectorAll(".theme-btn").forEach(function(b){b.classList.toggle("active",b.getAttribute("data-theme")===t)});try{localStorage.setItem(themeKey,t)}catch(e){}}
document.querySelectorAll(".theme-btn").forEach(function(b){b.addEventListener("click",function(){applyTheme(b.getAttribute("data-theme"))})});
try{applyTheme("light")}catch(e){applyTheme("light")}
loadFav();
/* ── Obsidian save: manual, original content → local vault via Local REST API plugin ── */
var obsKey="finhot-obsidian";
function loadObs(){try{return JSON.parse(localStorage.getItem(obsKey)||"{}")||{}}catch(e){return {}}}
function saveObs(c){try{localStorage.setItem(obsKey,JSON.stringify(c))}catch(e){}}
var obsToastTimer=null;
function obsToast(msg){var t=document.getElementById("obs-toast");if(!t)return;t.textContent=msg;t.classList.add("show");if(obsToastTimer)clearTimeout(obsToastTimer);obsToastTimer=setTimeout(function(){t.classList.remove("show")},3600)}
var OBS_INVALID=/[\\u0000-\\u001F\\u007F"#$%&*+,:;<=>?\\[\\]^\`{|}\\/\\\\]/g;
function obsSanitize(n){return String(n||"").replace(OBS_INVALID,"_")}
function obsHtmlToMd(html){if(!html)return "";var s=String(html).replace(/\\r\\n?/g,"\\n");s=s.replace(/<\\s*(script|style)[^>]*>[\\s\\S]*?<\\/\\s*\\1\\s*>/gi,"");s=s.replace(/<\\s*h([1-6])[^>]*>/gi,function(m,n){var p="";for(var i=0;i<+n;i++)p+="#";return "\\n\\n"+p+" "});s=s.replace(/<\\s*br\\s*\\/?>/gi,"\\n");s=s.replace(/<\\/\\s*p\\s*>/gi,"\\n\\n");s=s.replace(/<\\s*li[^>]*>/gi,"- ");s=s.replace(/<\\/\\s*(li|tr)\\s*>/gi,"\\n");s=s.replace(/<\\/\\s*(ul|ol|div|blockquote|h[1-6])\\s*>/gi,"\\n");s=s.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\\s\\S]*?)<\\/a>/gi,function(m,href,txt){var t=txt.replace(/<[^>]+>/g,"").trim();return t?"["+t+"]("+href+")":href});s=s.replace(/<img[^>]*src=["']([^"']*)["'][^>]*>/gi,function(m,src){return "![]("+src+")"});s=s.replace(/<\\s*(strong|b)\\s*>/gi,"**").replace(/<\\/\\s*(strong|b)\\s*>/gi,"**");s=s.replace(/<\\s*(em|i)\\s*>/gi,"*").replace(/<\\/\\s*(em|i)\\s*>/gi,"*");s=s.replace(/<[^>]+>/g,"");var d=document.createElement("textarea");d.innerHTML=s;s=d.value;s=s.replace(/[ \\t]+\\n/g,"\\n").replace(/\\n{3,}/g,"\\n\\n").trim();return s}
function obsIsScalar(v){return /^[\\w-]+$/.test(v)}
function obsYamlStr(v){v=String(v).replace(/\\r\\n?/g,"\\n");if(v.indexOf("\\n")<0)return JSON.stringify(v);var lines=v.replace(/\\n+$/g,"").split("\\n");var out=["|-"];for(var i=0;i<lines.length;i++)out.push(lines[i].length?"  "+lines[i]:"");return out.join("\\n")}
function obsField(k,v){if(v==null||v==="")return[];var parts=obsYamlStr(v).split("\\n");parts[0]=k+": "+parts[0];return parts}
function obsForce(k,v){var parts=obsYamlStr(v==null?"":v).split("\\n");parts[0]=k+": "+parts[0];return parts}
function obsArr(k,a){if(!a||!a.length)return[];var out=[k+":"];for(var i=0;i<a.length;i++){var x=String(a[i]).replace(/\\r\\n?/g,"\\n");out.push("  - "+(obsIsScalar(x)?x:JSON.stringify(x)))}return out}
function obsPub(v){return String(v||"").replace(/\\.\\d{3}Z$/,"").replace(/Z$/,"")}
function obsFrontmatter(m){var f=[];f=f.concat(obsForce("url",m.url));f=f.concat(obsForce("author",m.author));f.push("publishedAt: "+obsPub(m.publishedAt));f=f.concat(obsField("description",m.description));f=f.concat(obsArr("tags",m.tags));f=f.concat(obsField("feedTitle",m.feedTitle));f=f.concat(obsField("feedUrl",m.feedUrl));return ["---"].concat(f).concat(["---"]).join("\\n")}
function obsBuildNote(e,f){var title=String(e.title||"").trim();var meta={url:e.url||"",author:e.author||"",publishedAt:e.publishedAt||"",description:e.description?strip(e.description).replace(/\\s+/g," ").trim():"",tags:["folo"],feedTitle:f.title||"",feedUrl:f.url||""};var content=obsHtmlToMd(e.content||e.description||"");var fileName=obsSanitize(title||obsPub(meta.publishedAt)).trim().slice(0,80)+".md";var md=obsFrontmatter(meta)+"\\n\\n# "+title+"\\n\\n"+content+"\\n";return {fileName:fileName,markdown:md}}
function saveEntryToObsidian(entryId){var cfg=loadObs();if(!cfg.endpoint||!cfg.token){obsToast("请先配置 Obsidian 地址与 API Key");openObsidianSettings();return}var e=allEntries.find(function(x){return x.id===entryId});if(!e){obsToast("未找到条目");return}var f=feedMap[e.feedId]||{};var note;try{note=obsBuildNote(e,f)}catch(err){obsToast("生成笔记失败");return}var base=String(cfg.endpoint).replace(/\\/+$/,"");var folder=String(cfg.folder||"").replace(/^\\/+|\\/+$/g,"");var notePath=folder?folder+"/"+note.fileName:note.fileName;var encoded=notePath.split("/").map(encodeURIComponent).join("/");obsToast("正在保存到 Obsidian…");fetch(base+"/vault/"+encoded,{method:"PUT",headers:{"Authorization":"Bearer "+cfg.token,"Content-Type":"text/markdown"},body:note.markdown}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);obsToast("已保存到 Obsidian ✓")}).catch(function(err){obsToast("保存失败："+((err&&err.message)||err)+"（检查插件/证书/地址）")})}
function openObsidianSettings(){var cfg=loadObs();document.getElementById("obs-endpoint").value=cfg.endpoint||"https://127.0.0.1:27124";document.getElementById("obs-token").value=cfg.token||"";document.getElementById("obs-folder").value=cfg.folder||"";document.getElementById("obs-modal").classList.add("open")}
function closeObsidianSettings(){document.getElementById("obs-modal").classList.remove("open")}
function commitObsidianSettings(){var cfg={endpoint:(document.getElementById("obs-endpoint").value||"").trim(),token:(document.getElementById("obs-token").value||"").trim(),folder:(document.getElementById("obs-folder").value||"").trim()};saveObs(cfg);closeObsidianSettings();obsToast("Obsidian 设置已保存")}
document.getElementById("obs-close").addEventListener("click",closeObsidianSettings);
document.getElementById("obs-cancel").addEventListener("click",closeObsidianSettings);
document.getElementById("obs-save").addEventListener("click",commitObsidianSettings);
document.getElementById("obs-modal").addEventListener("click",function(ev){if(ev.target===this)closeObsidianSettings()});
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
<link rel="icon" href="data:image/png;base64,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" type="image/png">
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
.logo-text{font-size:17px;font-weight:800;letter-spacing:-0.02em;font-style:italic;background:linear-gradient(135deg,#ff6b35,#f7931e,#ff4500,#ff6b35);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;text-shadow:0 0 20px rgba(255,107,53,0.3);filter:drop-shadow(0 0 2px rgba(255,107,53,0.2))}
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
<img src="data:image/png;base64,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" alt="FinHot" style="width:26px;height:26px;border-radius:7px">
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
function articleHtml(s,hl){if(!s)return"";var t=esc(String(s).trim()).replace(/\\n{3,}/g,"\\n\\n");if(t.indexOf("\\n")<0){var _sn=t.match(/[^\\u3002\\uff01\\uff1f!?\\n]+[\\u3002\\uff01\\uff1f!?]+/g);if(_sn&&_sn.length>=3){t="";for(var _k=0;_k<_sn.length;_k++){t+=_sn[_k];if((_k+1)%2===0&&_k<_sn.length-1)t+="\\n\\n"}}}t=t.replace(/([^\\n])([\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341]+\\u3001)/g,"$1\\n$2");t=t.replace(/([^\\n\\u3001])(\\d+\\u3001)/g,"$1\\n$2");t=t.replace(/([^\\n])(No\\.\\d+)/gi,"$1\\n$2");var lines=t.split(/\\n/);var out="";var ul=0;for(var i=0;i<lines.length;i++){var ln=lines[i].trim();if(!ln){if(ul){out+="</ul>";ul=0}continue}if(/^[\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341]+[\\u3001.]/.test(ln)){if(ul){out+="</ul>";ul=0}out+="<h3>"+artHL(ln,hl)+"</h3>";continue}if(/^[\\uff08(][\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341]+[\\uff09)]/.test(ln)){if(ul){out+="</ul>";ul=0}out+="<h4>"+artHL(ln,hl)+"</h4>";continue}if(/^No\\.\\d+$/i.test(ln)){if(ul){out+="</ul>";ul=0}out+='<span class="art-sep">'+ln+'</span>';continue}if(/^\\d{1,2}\\u3001/.test(ln)){if(!ul){out+="<ul>";ul=1}out+="<li>"+artHL(ln.replace(/^\\d{1,2}\\u3001\\s*/,""),hl)+"</li>";continue}if(/^[\\xb7\\u2022\\-]\\s/.test(ln)){if(!ul){out+="<ul>";ul=1}out+="<li>"+artHL(ln.replace(/^[\\xb7\\u2022\\-]\\s+/,""),hl)+"</li>";continue}if(ul){out+="</ul>";ul=0}out+="<p>"+artHL(ln,hl)+"</p>"}if(ul)out+="</ul>";return out}
function artHL(s,hl){var ex=[];if(hl&&hl.length){for(var _i=0;_i<hl.length;_i++){var _t=String(typeof hl[_i]==="object"?(hl[_i].label||hl[_i].name||""):(hl[_i]||"")).trim();if(_t.length>=2&&!/[.*+?^|(){}\\[\\]\\\\]/.test(_t)&&ex.indexOf(_t)<0)ex.push(_t)}}ex.sort(function(a,b){return b.length-a.length});var alt=ex.join("|");var re=new RegExp("==([^=]+)==|《([^》]+)》|【([^】]+)】"+(alt?"|("+alt+")":""),"g");return s.replace(re,function(m,a,b,c,d){if(a!=null)return"<mark>"+a+"</mark>";if(b!=null)return"<strong>《"+b+"》</strong>";if(c!=null)return"<strong>【"+c+"】</strong>";if(d!=null)return'<mark class="hl-tag">'+d+"</mark>";return m})}

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
function passesScoreGateSV(e){var f=feedMap[e.feedId];if(!f)return false;var en=enrichments[e.id];var sc=en&&en.qualityDetails&&en.qualityDetails.scores;if(!sc||Object.keys(sc).length===0)return false;var p=getPlatform(f.url,f.category);if(p==="wechat")return true;var qs=en.qualityScore;return qs!=null&&qs>=SCORE_GATE_SV}

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

  var platSV=platform(feedMap[e.feedId]);
  if(reason&&platSV!=="wechat"){h+='<div class="card-reason">\u63A8\u8350\u7406\u7531\uFF1A'+esc(reason)+'</div>'}

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
    if(bodyText){h+='<div class="fp-section"><div class="fp-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>\u539F\u6587</div><div class="fp-section-body fp-article">'+articleHtml(bodyText,en.tags||[])+'</div></div>'}
  } else if(bodyText){
    h+='<div class="fp-section"><div class="fp-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>\u539F\u6587</div><div class="fp-section-body fp-article">'+articleHtml(bodyText,en.tags||[])+'</div></div>';
  }
  if(e.url){h+='<a class="fp-orig-link" href="'+esc(e.url)+'" target="_blank" rel="noopener">\u6253\u5F00\u539F\u6587 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg></a>'}
  h+='</div>';
  fp.innerHTML=h;fp.scrollTop=0;fp.classList.add("open");
  document.getElementById("fp-back").addEventListener("click",function(){showFullDetail(null)});
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

/**
 * Canonicalize an HTTP(S) feed URL so the same source spelled differently
 * (e.g. `127.0.0.1:8090` vs `localhost:8090`, or with a default port) maps to
 * one feed/entry id. Without this, the same wechat2rss/RSSHub feed registered
 * under two host spellings produces duplicate feeds and entries on the public
 * page. Non-HTTP URLs (e.g. `finhot://...`) are returned unchanged.
 */
function normalizeFeedUrl(rawUrl: string): string {
  if (!/^https?:\/\//i.test(rawUrl)) return rawUrl
  try {
    const u = new URL(rawUrl)
    let host = u.hostname.toLowerCase()
    if (host === "127.0.0.1" || host === "::1" || host === "[::1]") host = "localhost"
    u.hostname = host
    if (
      (u.protocol === "http:" && u.port === "80") ||
      (u.protocol === "https:" && u.port === "443")
    ) {
      u.port = ""
    }
    return u.toString()
  } catch {
    return rawUrl
  }
}

function parseRssFeed(xml: string, rawFeedUrl: string, limit: number) {
  const feedUrl = normalizeFeedUrl(rawFeedUrl)
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

// Parse a feed entry date into an ISO string. Handles ISO 8601, RFC 822 and
// bare epoch timestamps in seconds or milliseconds. Some RSSHub routes (e.g.
// the cninfo/巨潮 route) emit `<published>1782748800000</published>` as a raw
// millisecond integer, which `new Date(string)` cannot parse and would throw
// "Invalid time value" on `.toISOString()`. Falls back to now when unparseable.
function parseFeedDate(raw: string | null): string {
  if (!raw) return new Date().toISOString()
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed)
    // 13+ digits ≈ epoch ms; 10-digit values are epoch seconds.
    const ms = trimmed.length >= 13 ? n : n * 1000
    const fromEpoch = new Date(ms)
    return Number.isNaN(fromEpoch.getTime()) ? new Date().toISOString() : fromEpoch.toISOString()
  }
  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString()
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
      const publishedAt = parseFeedDate(pubDate)

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
