import { FeedViewType } from "@follow/constants"
import { getSubscriptionByFeedId } from "@follow/store/subscription/getter"
import { beforeEach, describe, expect, test, vi } from "vitest"

import { ROUTE_ENTRY_PENDING, ROUTE_FEED_PENDING } from "~/constants"

import { getNavigateEntryPath, parseNavigateEntryOptions } from "./navigate-entry-options"

vi.mock("@follow/components/atoms/route.js", () => ({
  getReadonlyRoute: vi.fn(),
}))

vi.mock("@follow/store/subscription/getter", () => ({
  getSubscriptionByFeedId: vi.fn(),
}))

const { getReadonlyRoute } = await import("@follow/components/atoms/route.js")

const youtubeFeedId = "feed/youtube-test"

describe("parseNavigateEntryOptions", () => {
  beforeEach(() => {
    vi.mocked(getReadonlyRoute).mockReturnValue({
      params: {
        timelineId: "all",
        feedId: youtubeFeedId,
        entryId: ROUTE_ENTRY_PENDING,
      },
      location: { pathname: `/timeline/all/${youtubeFeedId}/${ROUTE_ENTRY_PENDING}`, search: "" },
      searchParams: new URLSearchParams(),
    } as unknown as ReturnType<typeof getReadonlyRoute>)

    vi.mocked(getSubscriptionByFeedId).mockReturnValue({
      view: FeedViewType.Videos,
    } as ReturnType<typeof getSubscriptionByFeedId>)
  })

  test("preserves All timeline when clearing entry on the same YouTube feed", () => {
    const parsed = parseNavigateEntryOptions({
      feedId: youtubeFeedId,
      entryId: null,
    })

    expect(parsed.timelineId).toBe("all")
    expect(parsed.feedId).toBe(encodeURIComponent(youtubeFeedId))
    expect(parsed.entryId).toBe(ROUTE_ENTRY_PENDING)
  })

  test("uses All timeline when navigating to a different feed without explicit view", () => {
    const nextFeedId = "feed/another-youtube"

    const parsed = parseNavigateEntryOptions({
      feedId: nextFeedId,
      entryId: null,
    })

    expect(parsed.timelineId).toBe("all")
    expect(parsed.feedId).toBe(encodeURIComponent(nextFeedId))
  })

  test("uses explicit view timeline when provided", () => {
    const parsed = parseNavigateEntryOptions({
      feedId: youtubeFeedId,
      entryId: null,
      view: FeedViewType.All,
    })

    expect(parsed.timelineId).toBe("all")
  })

  test("preserves current timeline when returning to all feeds home", () => {
    const parsed = parseNavigateEntryOptions({
      feedId: null,
      entryId: null,
      view: FeedViewType.All,
    })

    expect(parsed.timelineId).toBe("all")
    expect(parsed.feedId).toBe(encodeURIComponent(ROUTE_FEED_PENDING))
  })
})

describe("getNavigateEntryPath", () => {
  beforeEach(() => {
    vi.mocked(getReadonlyRoute).mockReturnValue({
      params: {
        timelineId: "all",
        feedId: youtubeFeedId,
        entryId: "entry-1",
      },
      location: {
        pathname: `/timeline/all/${youtubeFeedId}/entry-1`,
        search: "",
      },
      searchParams: new URLSearchParams(),
    } as unknown as ReturnType<typeof getReadonlyRoute>)

    vi.mocked(getSubscriptionByFeedId).mockReturnValue({
      view: FeedViewType.Videos,
    } as ReturnType<typeof getSubscriptionByFeedId>)
  })

  test("back-to-feed navigation keeps All timeline instead of switching to Videos grid", () => {
    const path = getNavigateEntryPath({
      feedId: youtubeFeedId,
      entryId: null,
      view: FeedViewType.All,
    })

    expect(path).toBe(`/timeline/all/${encodeURIComponent(youtubeFeedId)}/${ROUTE_ENTRY_PENDING}`)
  })
})
