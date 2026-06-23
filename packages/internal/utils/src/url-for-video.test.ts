import { describe, expect, it } from "vitest"

import {
  buildYouTubeWatchUrl,
  extractYouTubeVideoId,
  isYouTubeSubscriptionFeed,
  isYouTubeSubscriptionFeedUrl,
  isYouTubeWatchUrl,
  normalizeYouTubeWatchUrl,
  resolveYouTubeWatchUrl,
} from "./url-for-video"

describe("isYouTubeWatchUrl", () => {
  it("detects YouTube watch and shorts URLs", () => {
    expect(isYouTubeWatchUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true)
    expect(isYouTubeWatchUrl("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true)
    expect(isYouTubeWatchUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(true)
    expect(isYouTubeWatchUrl("https://example.com/watch?v=dQw4w9WgXcQ")).toBe(false)
  })
})

describe("resolveYouTubeWatchUrl", () => {
  it("builds watch URL from yt:video guid", () => {
    expect(
      resolveYouTubeWatchUrl({
        guid: "yt:video:dQw4w9WgXcQ",
      }),
    ).toBe(buildYouTubeWatchUrl("dQw4w9WgXcQ"))
  })

  it("normalizes watch URLs without www", () => {
    expect(
      resolveYouTubeWatchUrl({
        url: "https://youtube.com/watch?v=dQw4w9WgXcQ&t=120",
      }),
    ).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
  })
})

describe("normalizeYouTubeWatchUrl", () => {
  it("removes timestamp query params", () => {
    expect(normalizeYouTubeWatchUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    )
  })
})

describe("isYouTubeSubscriptionFeedUrl", () => {
  it("detects YouTube channel and feed URLs", () => {
    expect(
      isYouTubeSubscriptionFeedUrl(
        "https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890",
      ),
    ).toBe(true)
    expect(isYouTubeSubscriptionFeedUrl("https://www.youtube.com/channel/UC1234567890")).toBe(true)
    expect(isYouTubeSubscriptionFeedUrl("https://www.youtube.com/@example")).toBe(true)
    expect(isYouTubeSubscriptionFeedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(false)
    expect(isYouTubeSubscriptionFeedUrl("https://example.com/feeds/videos.xml")).toBe(false)
  })
})

describe("isYouTubeSubscriptionFeed", () => {
  it("matches when either feed url or site url is YouTube", () => {
    expect(
      isYouTubeSubscriptionFeed({
        url: "https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890",
        siteUrl: null,
      }),
    ).toBe(true)
    expect(
      isYouTubeSubscriptionFeed({
        url: "https://example.com/feed.xml",
        siteUrl: "https://www.youtube.com/@example",
      }),
    ).toBe(true)
  })
})

describe("extractYouTubeVideoId", () => {
  it("extracts ids from guid and watch URLs", () => {
    expect(extractYouTubeVideoId("yt:video:dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ")
    expect(extractYouTubeVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ")
  })
})
