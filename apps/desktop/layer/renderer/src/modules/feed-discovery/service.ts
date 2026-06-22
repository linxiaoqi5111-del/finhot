/**
 * Feed auto-discovery service.
 *
 * Given any URL, attempts to find RSS/Atom/JSON Feed URLs by:
 * 1. Checking if the URL itself is a valid feed (via the RSS preview service).
 * 2. Fetching the HTML page and extracting `<link rel="alternate" type="application/rss+xml">` etc.
 * 3. Trying common WordPress / static-site fallback paths (/feed, /rss, /atom.xml, /index.xml, /feed.xml).
 *
 * Inspired by NetNewsWire's FeedFinder module.
 */

export interface DiscoveredFeed {
  url: string
  title: string | null
  source: "direct" | "html-head" | "fallback"
}

const FEED_MIME_TYPES = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/json",
  "application/feed+json",
  "text/xml",
  "application/xml",
])

const FALLBACK_PATHS = ["/feed", "/feed/", "/rss", "/atom.xml", "/index.xml", "/feed.xml"]

/**
 * Try to preview a URL as a feed via the server-side proxy.
 * Returns the feed title on success, null on failure.
 */
const probeAsFeed = async (url: string): Promise<string | null> => {
  try {
    const res = await fetch("/api/rss/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, lite: true, limit: 1 }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { feed?: { title?: string | null } }
    return data.feed?.title ?? "(Untitled Feed)"
  } catch {
    return null
  }
}

/**
 * Parse `<link>` elements from the HTML `<head>` that point to feeds.
 */
const extractFeedLinksFromHtml = (html: string, baseUrl: string): DiscoveredFeed[] => {
  const feeds: DiscoveredFeed[] = []
  const seen = new Set<string>()

  // Match <link> tags with type containing feed MIME types
  const linkRegex = /<link\s[^>]*?\/?>/gi
  let match: RegExpExecArray | null = linkRegex.exec(html)
  while (match) {
    const tag = match[0]

    const relMatch = /rel\s*=\s*["']([^"']*)["']/i.exec(tag)
    const typeMatch = /type\s*=\s*["']([^"']*)["']/i.exec(tag)
    const hrefMatch = /href\s*=\s*["']([^"']*)["']/i.exec(tag)
    const titleMatch = /title\s*=\s*["']([^"']*)["']/i.exec(tag)

    if (relMatch && hrefMatch && typeMatch) {
      const rel = relMatch[1]?.toLowerCase() ?? ""
      const type = typeMatch[1]?.toLowerCase() ?? ""
      const href = hrefMatch[1] ?? ""

      if (rel === "alternate" && FEED_MIME_TYPES.has(type) && href) {
        try {
          const feedUrl = new URL(href, baseUrl).href
          if (!seen.has(feedUrl)) {
            seen.add(feedUrl)
            feeds.push({
              url: feedUrl,
              title: titleMatch?.[1] ?? null,
              source: "html-head",
            })
          }
        } catch {
          // Invalid URL, skip
        }
      }
    }

    match = linkRegex.exec(html)
  }

  return feeds
}

/**
 * Discover feeds at the given URL.
 *
 * Returns an array of discovered feeds sorted by reliability:
 * direct feed > HTML <head> links > fallback paths.
 */
export const discoverFeeds = async (inputUrl: string): Promise<DiscoveredFeed[]> => {
  const trimmed = inputUrl.trim()
  if (!trimmed) return []

  let url: URL
  try {
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`)
  } catch {
    return []
  }

  const results: DiscoveredFeed[] = []

  // Step 1: Try the URL directly as a feed
  const directTitle = await probeAsFeed(url.href)
  if (directTitle) {
    results.push({ url: url.href, title: directTitle, source: "direct" })
    return results
  }

  // Step 2: Fetch the page HTML and look for <link rel="alternate"> feed links
  try {
    const res = await fetch("/api/rss/proxy-html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.href }),
    })

    if (res.ok) {
      const html = await res.text()
      const htmlFeeds = extractFeedLinksFromHtml(html, url.href)
      results.push(...htmlFeeds)
    }
  } catch {
    // HTML fetch failed, continue to fallback paths
  }

  // Step 3: Try common fallback paths
  const fallbackProbes = FALLBACK_PATHS.map(async (path) => {
    const fallbackUrl = new URL(path, url.origin).href
    // Skip if we already found this URL from HTML head
    if (results.some((r) => r.url === fallbackUrl)) return null

    const title = await probeAsFeed(fallbackUrl)
    if (title) {
      return { url: fallbackUrl, title, source: "fallback" as const }
    }
    return null
  })

  const fallbackResults = await Promise.all(fallbackProbes)
  for (const r of fallbackResults) {
    if (r) results.push(r)
  }

  return results
}
