import crypto from "node:crypto"

import { version as appVersion } from "@pkg"
import type { IpcContext } from "electron-ipc-decorator"
import { IpcMethod, IpcService } from "electron-ipc-decorator"

const RSS_FETCH_USER_AGENT = `FinHot/${appVersion} (RSS Reader)`
const RSS_FETCH_TIMEOUT_MS = 120_000
const RSS_PREVIEW_LITE_TIMEOUT_MS = 30_000
const RSS_PREVIEW_LITE_ENTRY_LIMIT = 8
const RSS_PREVIEW_CACHE_TTL_MS = 5 * 60 * 1000

interface RssPreviewInput {
  url: string
  lite?: boolean
  limit?: number
}

interface RssPreviewCacheEntry {
  expiresAt: number
  result: LocalRssPreview
}

const previewCache = new Map<string, RssPreviewCacheEntry>()

interface LocalRssFeed {
  id: string
  title: string | null
  url: string
  description: string | null
  image: string | null
  errorAt: string | null
  siteUrl: string | null
  ownerUserId: string | null
  errorMessage: string | null
  subscriptionCount: number | null
  updatesPerWeek: number | null
  latestEntryPublishedAt: string | null
  tipUserIds: string[] | null
  updatedAt: string
}

interface LocalRssMedia {
  url: string
  type: "photo" | "video"
  preview_image_url?: string
  width?: number
  height?: number
}

interface LocalRssAttachment {
  url: string
  duration_in_seconds?: number | string
  mime_type?: string
  size_in_bytes?: number
  title?: string
}

interface LocalRssEntry {
  id: string
  title: string | null
  url: string | null
  content: string | null
  readabilityContent: string | null
  readabilityUpdatedAt: string | null
  description: string | null
  guid: string
  author: string | null
  authorUrl: string | null
  authorAvatar: string | null
  insertedAt: string
  publishedAt: string
  media: LocalRssMedia[] | null
  categories: string[] | null
  attachments: LocalRssAttachment[] | null
  extra: null
  language: string | null
  feedId: string
  inboxHandle: null
  read: boolean
  sources: string[] | null
  settings: null
}

interface LocalRssPreview {
  feed: LocalRssFeed
  entries: LocalRssEntry[]
}

const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 24)

const toLocalFeedId = (url: string) => `local-feed-${hash(url)}`

const toLocalEntryId = (feedId: string, guid: string) => `local-entry-${hash(`${feedId}:${guid}`)}`

const normalizeFeedUrl = (rawUrl: string) => {
  const url = rawUrl.trim()
  if (!url) {
    throw new Error("RSS URL is required")
  }

  const hasProtocol = /^[a-z][\d+.a-z-]*:\/\//i.test(url)
  if (hasProtocol && !/^https?:\/\//i.test(url)) {
    throw new Error("Only HTTP and HTTPS RSS URLs are supported")
  }

  const normalizedUrl = hasProtocol ? url : `https://${url}`
  const parsed = new URL(normalizedUrl)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS RSS URLs are supported")
  }

  const hostname = parsed.hostname.toLowerCase()
  if (
    !hostname ||
    (hostname !== "localhost" && !hostname.includes(".") && !hostname.includes(":"))
  ) {
    throw new Error("Enter a complete HTTP or HTTPS RSS URL.")
  }

  return parsed.toString()
}

const fetchFeedXml = async (url: string, timeoutMs = RSS_FETCH_TIMEOUT_MS) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent": RSS_FETCH_USER_AGENT,
      },
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `RSS feed request timed out after ${timeoutMs / 1000}s. The server may be slow or unreachable.`,
      )
    }

    const message = error instanceof Error ? error.message : "Network request failed"
    throw new Error(`Failed to fetch RSS feed: ${message}`)
  } finally {
    clearTimeout(timeout)
  }
}

const decodeXmlEntities = (value: string) =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replaceAll(/&#x([\da-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )

const stripCdata = (value: string) => value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "")

const cleanupText = (value: string | null | undefined) => {
  if (!value) return null
  const text = decodeXmlEntities(stripCdata(value).replaceAll(/<[^>]+>/g, ""))
    .replaceAll(/\s+/g, " ")
    .trim()
  return text || null
}

const cleanupHtml = (value: string | null | undefined) => {
  if (!value) return null
  const html = decodeXmlEntities(stripCdata(value)).trim()
  return html || null
}

const escapeRegExp = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")

const getTagContent = (xml: string, tag: string) => {
  const escapedTag = escapeRegExp(tag)
  const match = xml.match(new RegExp(`<${escapedTag}\\b[^>]*>([\\s\\S]*?)</${escapedTag}>`, "i"))
  return match?.[1] ?? null
}

const getFirstTagContent = (xml: string, tags: string[]) => {
  for (const tag of tags) {
    const content = getTagContent(xml, tag)
    if (content) return content
  }
  return null
}

const getTagText = (xml: string, tags: string[]) => cleanupText(getFirstTagContent(xml, tags))

const getTagHtml = (xml: string, tags: string[]) => cleanupHtml(getFirstTagContent(xml, tags))

const getAttributes = (source: string) => {
  const attributes: Record<string, string> = {}

  for (const match of source.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const key = match[1]
    const value = match[2] ?? match[3]
    if (!key || value === undefined) continue
    attributes[key.toLowerCase()] = decodeXmlEntities(value)
  }

  return attributes
}

const getFirstLinkHref = (xml: string) => {
  for (const match of xml.matchAll(/<link\b([^>]*)>/gi)) {
    const attributes = getAttributes(match[1] ?? "")
    const rel = attributes.rel?.toLowerCase()
    const { href } = attributes
    if (href && (!rel || rel === "alternate")) {
      return href
    }
  }

  return null
}

const getPermalinkGuid = (xml: string) => {
  const match = xml.match(/<guid\b([^>]*)>([\s\S]*?)<\/guid>/i)
  if (!match) return null

  const attributes = getAttributes(match[1] ?? "")
  const isPermalink = attributes.ispermalink?.toLowerCase() === "true"
  const value = cleanupText(match[2])

  if (!isPermalink || !value || !/^https?:\/\//i.test(value)) {
    return null
  }

  return value
}

const getFirstImage = (xml: string) => {
  const imageBlock = getTagContent(xml, "image")
  const imageUrl = imageBlock ? getTagText(imageBlock, ["url"]) : null
  if (imageUrl) return imageUrl

  for (const match of xml.matchAll(/<itunes:image\b([^>]*)>/gi)) {
    const { href } = getAttributes(match[1] ?? "")
    if (href) return href
  }

  return null
}

const parseDate = (value: string | null | undefined, fallback: Date) => {
  if (!value) return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date
}

const getMediaDescription = (xml: string) => {
  const match = xml.match(/<media:description\b[^>]*>([\s\S]*?)<\/media:description>/i)
  return match ? cleanupHtml(match[1]) : null
}

const getYouTubeWatchUrl = (xml: string, link: string | null) => {
  if (link && /youtube\.com\/(?:watch\?v=|shorts\/)/i.test(link)) {
    return link
  }

  const videoId = getTagText(xml, ["yt:videoId"])
  if (!videoId) return link

  return `https://www.youtube.com/watch?v=${videoId}`
}

const getCategories = (xml: string) => {
  const categories = Array.from(xml.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi))
    .map((match) => cleanupText(match[1]))
    .filter((category): category is string => !!category)

  return categories.length > 0 ? Array.from(new Set(categories)) : null
}

const getMediaAndAttachments = (xml: string) => {
  const media: LocalRssMedia[] = []
  const attachments: LocalRssAttachment[] = []

  const addMedia = (attributes: Record<string, string>, fallbackType?: "photo" | "video") => {
    const { url } = attributes
    if (!url) return

    const medium = attributes.medium?.toLowerCase()
    const mimeType = attributes.type?.toLowerCase()
    const type =
      fallbackType ??
      (medium === "video" || mimeType?.startsWith("video/")
        ? ("video" as const)
        : ("photo" as const))

    media.push({
      url,
      type,
      preview_image_url: attributes.thumbnail || attributes["preview_image_url"],
      width: attributes.width ? Number.parseInt(attributes.width, 10) || undefined : undefined,
      height: attributes.height ? Number.parseInt(attributes.height, 10) || undefined : undefined,
    })
  }

  for (const match of xml.matchAll(/<media:(?:thumbnail|content)\b([^>]*)>/gi)) {
    addMedia(getAttributes(match[1] ?? ""))
  }

  for (const match of xml.matchAll(/<enclosure\b([^>]*)>/gi)) {
    const attributes = getAttributes(match[1] ?? "")
    const { url } = attributes
    if (!url) continue

    const mimeType = attributes.type?.toLowerCase()
    if (mimeType?.startsWith("image/") || mimeType?.startsWith("video/")) {
      addMedia(attributes, mimeType.startsWith("video/") ? "video" : "photo")
      continue
    }

    const { length } = attributes

    attachments.push({
      url,
      mime_type: attributes.type,
      size_in_bytes: length ? Number.parseInt(length, 10) || undefined : undefined,
      title: attributes.title,
    })
  }

  return {
    media: media.length > 0 ? media : null,
    attachments: attachments.length > 0 ? attachments : null,
  }
}

const getFeedContainer = (xml: string) =>
  getTagContent(xml, "channel") ?? getTagContent(xml, "feed") ?? xml

interface ParseEntriesOptions {
  lite?: boolean
  limit?: number
}

const truncateFeedXmlForPreview = (xml: string, maxItems: number) => {
  if (maxItems <= 0) return xml

  let count = 0
  let cutIndex = xml.length

  for (const match of xml.matchAll(/<\/(?:item|entry)>/gi)) {
    count++
    if (count >= maxItems) {
      cutIndex = match.index! + match[0].length
      break
    }
  }

  return cutIndex < xml.length ? xml.slice(0, cutIndex) : xml
}

const collectEntryBlocks = (xml: string, limit: number) => {
  const blocks: string[] = []

  for (const regex of [
    /<item\b[^>]*>([\s\S]*?)<\/item>/gi,
    /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi,
  ]) {
    for (const match of xml.matchAll(regex)) {
      blocks.push(match[1] ?? "")
      if (blocks.length >= limit) {
        return blocks
      }
    }
  }

  return blocks
}

const parseEntryBlock = (block: string, feedId: string, now: Date, lite: boolean) => {
  const title = getTagText(block, ["title"])
  const rawLink = getTagText(block, ["link"]) ?? getFirstLinkHref(block) ?? getPermalinkGuid(block)
  const link = getYouTubeWatchUrl(block, rawLink)
  const guid =
    getTagText(block, ["guid", "id"]) ??
    link ??
    `${title ?? "Untitled"}:${getTagText(block, ["pubDate", "published", "updated", "dc:date"]) ?? hash(block)}`
  const publishedAt = parseDate(
    getTagText(block, ["pubDate", "published", "updated", "dc:date", "date"]),
    now,
  )
  const mediaDescription = lite ? null : getMediaDescription(block)
  const description = lite
    ? getTagText(block, ["description", "summary", "subtitle"])
    : (cleanupText(getTagHtml(block, ["description", "summary", "subtitle"])) ??
      cleanupText(mediaDescription))
  const content = lite
    ? null
    : (getTagHtml(block, ["content:encoded", "content"]) ??
      getTagHtml(block, ["description", "summary", "subtitle"]) ??
      mediaDescription)
  const { media, attachments } = lite
    ? { media: null, attachments: null }
    : getMediaAndAttachments(block)

  return {
    id: toLocalEntryId(feedId, guid),
    title,
    url: link,
    content,
    readabilityContent: null,
    readabilityUpdatedAt: null,
    description,
    guid,
    author: getTagText(block, ["author", "dc:creator", "creator", "name"]),
    authorUrl: getTagText(block, ["uri"]),
    authorAvatar: null,
    insertedAt: now.toISOString(),
    publishedAt: publishedAt.toISOString(),
    media,
    categories: lite ? null : getCategories(block),
    attachments,
    extra: null,
    language: null,
    feedId,
    inboxHandle: null,
    read: false,
    sources: null,
    settings: null,
  } satisfies LocalRssEntry
}

const parseEntries = (xml: string, feedId: string, options?: ParseEntriesOptions) => {
  const now = new Date()
  const lite = options?.lite ?? false
  const limit = options?.limit ?? Number.POSITIVE_INFINITY
  const sourceXml = lite && Number.isFinite(limit) ? truncateFeedXmlForPreview(xml, limit) : xml
  const blocks =
    Number.isFinite(limit) && limit > 0
      ? collectEntryBlocks(sourceXml, limit)
      : [
          ...Array.from(sourceXml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)).map(
            (match) => match[1] ?? "",
          ),
          ...Array.from(sourceXml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)).map(
            (match) => match[1] ?? "",
          ),
        ]

  return blocks.map((block) => parseEntryBlock(block, feedId, now, lite))
}

const getPreviewCacheKey = (url: string, lite: boolean, limit?: number) =>
  `${url}|lite:${lite ? 1 : 0}|limit:${limit ?? "all"}`

const readPreviewCache = (cacheKey: string) => {
  const cached = previewCache.get(cacheKey)
  if (!cached) return null

  if (cached.expiresAt <= Date.now()) {
    previewCache.delete(cacheKey)
    return null
  }

  return cached.result
}

const writePreviewCache = (cacheKey: string, result: LocalRssPreview) => {
  previewCache.set(cacheKey, {
    result,
    expiresAt: Date.now() + RSS_PREVIEW_CACHE_TTL_MS,
  })
}

export class RssService extends IpcService {
  static override readonly groupName = "rss"

  @IpcMethod()
  async preview(_context: IpcContext, input: RssPreviewInput): Promise<LocalRssPreview> {
    const url = normalizeFeedUrl(input.url)
    const lite = input.lite ?? false
    const limit = lite ? (input.limit ?? RSS_PREVIEW_LITE_ENTRY_LIMIT) : input.limit
    const cacheKey = lite ? getPreviewCacheKey(url, lite, limit) : null
    const cached = cacheKey ? readPreviewCache(cacheKey) : null
    if (cached) {
      return cached
    }

    const response = await fetchFeedXml(
      url,
      lite ? RSS_PREVIEW_LITE_TIMEOUT_MS : RSS_FETCH_TIMEOUT_MS,
    )

    if (!response.ok) {
      throw new Error(`Failed to fetch RSS feed: ${response.status} ${response.statusText}`)
    }

    const xml = await response.text()
    const finalUrl = response.url || url
    const feedId = toLocalFeedId(finalUrl)
    const container = getFeedContainer(xml)
    const entries = parseEntries(xml, feedId, { lite, limit })
    const latestEntryPublishedAt = entries
      .map((entry) => entry.publishedAt)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]

    const feed = {
      id: feedId,
      title: getTagText(container, ["title"]) ?? new URL(finalUrl).hostname,
      url: finalUrl,
      description: getTagText(container, ["description", "subtitle"]),
      image: getFirstImage(container),
      errorAt: null,
      siteUrl:
        getTagText(container, ["link"]) ?? getFirstLinkHref(container) ?? new URL(finalUrl).origin,
      ownerUserId: null,
      errorMessage: null,
      subscriptionCount: null,
      updatesPerWeek: null,
      latestEntryPublishedAt: latestEntryPublishedAt ?? null,
      tipUserIds: null,
      updatedAt: new Date().toISOString(),
    } satisfies LocalRssFeed

    const result = {
      feed,
      entries,
    }

    if (cacheKey) {
      writePreviewCache(cacheKey, result)
    }

    return result
  }
}
