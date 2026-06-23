const YOUTUBE_WATCH_URL_PATTERN = /\/\/(?:www\.)?youtube\.com\/(?:watch\?v=|shorts\/)[\w-]+/
const YOUTUBE_FEED_URL_PATTERN =
  /\/\/(?:www\.)?youtube\.com\/(?:feeds\/videos\.xml|channel\/|user\/|@)/i
const YOUTUBE_VIDEO_ID_PATTERN = /^[\w-]{11}$/

export const isYouTubeSubscriptionFeedUrl = (url: string | null | undefined) => {
  if (!url) return false

  try {
    const { hostname, pathname } = new URL(url)
    if (!hostname.includes("youtube.com")) return false

    return (
      pathname.includes("/feeds/videos") ||
      pathname.startsWith("/channel/") ||
      pathname.startsWith("/user/") ||
      pathname.startsWith("/@")
    )
  } catch {
    return YOUTUBE_FEED_URL_PATTERN.test(url)
  }
}

export const isYouTubeSubscriptionFeed = (feed: { url?: string | null; siteUrl?: string | null }) =>
  isYouTubeSubscriptionFeedUrl(feed.url) || isYouTubeSubscriptionFeedUrl(feed.siteUrl)

export const isYouTubeWatchUrl = (url: string | null | undefined) => {
  if (!url) return false
  return YOUTUBE_WATCH_URL_PATTERN.test(url)
}

export const extractYouTubeVideoId = (value: string | null | undefined) => {
  if (!value) return null

  const guidMatch = value.match(/^yt:video:([\w-]+)$/i)
  if (guidMatch?.[1] && YOUTUBE_VIDEO_ID_PATTERN.test(guidMatch[1])) {
    return guidMatch[1]
  }

  if (!isYouTubeWatchUrl(value)) return null

  return (
    value.match(/\/\/(?:www\.)?youtube\.com\/watch\?v=([\w-]+)/)?.[1] ??
    value.match(/\/\/(?:www\.)?youtube\.com\/shorts\/([\w-]+)/)?.[1] ??
    null
  )
}

export const buildYouTubeWatchUrl = (videoId: string) =>
  `https://www.youtube.com/watch?v=${videoId}`

export const resolveYouTubeWatchUrl = (input: { url?: string | null; guid?: string | null }) => {
  const fromUrl = extractYouTubeVideoId(input.url)
  if (fromUrl) return buildYouTubeWatchUrl(fromUrl)

  const fromGuid = extractYouTubeVideoId(input.guid)
  if (fromGuid) return buildYouTubeWatchUrl(fromGuid)

  return null
}

export const normalizeYouTubeWatchUrl = (url: string) => {
  const videoId = extractYouTubeVideoId(url)
  if (!videoId) return url

  return buildYouTubeWatchUrl(videoId)
}

export const transformVideoUrl = ({
  url,
  mini = false,
  isIframe = false,
  attachments,
  lang,
}: {
  url: string
  mini?: boolean
  isIframe?: boolean
  attachments?:
    | {
        url: string
        mime_type?: string
      }[]
    | null
  lang?: string
}): string | null => {
  if (url?.match(/\/\/www.bilibili.com\/video\/BV\w+/)) {
    const player = isIframe
      ? "https://player.bilibili.com/player.html"
      : "https://www.bilibili.com/blackboard/newplayer.html"
    return `${player}?${new URLSearchParams({
      isOutside: "true",
      autoplay: "true",
      danmaku: "true",
      muted: mini ? "true" : "false",
      highQuality: "true",
      bvid: url.match(/\/\/www.bilibili.com\/video\/(BV\w+)/)?.[1] || "",
    }).toString()}`
  }

  if (url?.match(/\/\/(?:www\.)?youtube\.com\/(watch\?v=|shorts\/)[-\w]+/)) {
    const videoId = extractYouTubeVideoId(url)
    if (!videoId) return null

    return `https://www.youtube-nocookie.com/embed/${videoId}?${new URLSearchParams({
      controls: mini ? "0" : "1",
      autoplay: "1",
      mute: mini ? "1" : "0",
      hl: lang ?? "en-US",
      cc_lang_pref: lang ?? "en-US",
    }).toString()}`
  }

  if (url?.match(/\/\/www.pornhub.com\/view_video.php\?viewkey=\w+/)) {
    if (mini) {
      return null
    } else {
      return `https://www.pornhub.com/embed/${url.match(/\/\/www.pornhub.com\/view_video.php\?viewkey=(\w+)/)?.[1]}?${new URLSearchParams(
        {
          autoplay: "1",
        },
      ).toString()}`
    }
  }

  if (attachments) {
    return attachments.find((attachment) => attachment.mime_type === "text/html")?.url ?? null
  }
  return null
}
