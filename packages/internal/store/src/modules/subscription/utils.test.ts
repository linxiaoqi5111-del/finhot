import { FeedViewType } from "@follow/constants"
import { beforeEach, describe, expect, it } from "vitest"

import { feedActions } from "../feed/store"
import type { SubscriptionModel } from "./types"
import { getCorrectedSubscriptionView, inferSubscriptionViewFromFeed } from "./utils"

const createSubscription = (overrides: Partial<SubscriptionModel> = {}): SubscriptionModel => ({
  feedId: "feed-1",
  listId: null,
  inboxId: null,
  userId: "user-1",
  view: FeedViewType.Videos,
  isPrivate: false,
  hideFromTimeline: null,
  title: "Example Feed",
  category: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  type: "feed",
  ...overrides,
})

describe("inferSubscriptionViewFromFeed", () => {
  it("uses Videos view for YouTube feeds", () => {
    expect(
      inferSubscriptionViewFromFeed({
        url: "https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890",
        siteUrl: null,
      }),
    ).toBe(FeedViewType.Videos)
  })

  it("uses Articles view for non-YouTube feeds", () => {
    expect(
      inferSubscriptionViewFromFeed({
        url: "https://example.com/rss.xml",
        siteUrl: "https://bestblogs.dev",
      }),
    ).toBe(FeedViewType.Articles)
  })
})

describe("getCorrectedSubscriptionView", () => {
  beforeEach(() => {
    feedActions.upsertManyInSession([
      {
        id: "feed-1",
        url: "https://example.com/rss.xml",
        siteUrl: "https://bestblogs.dev",
        title: "Bestblogs",
        description: null,
        errorAt: null,
        errorMessage: null,
        image: null,
        ownerUserId: null,
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: "feed-2",
        url: "https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890",
        siteUrl: "https://www.youtube.com/@example",
        title: "YouTube Channel",
        description: null,
        errorAt: null,
        errorMessage: null,
        image: null,
        ownerUserId: null,
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ])
  })

  it("moves non-YouTube feeds out of Videos view", () => {
    expect(
      getCorrectedSubscriptionView(
        createSubscription({
          feedId: "feed-1",
          view: FeedViewType.Videos,
        }),
      ),
    ).toBe(FeedViewType.Articles)
  })

  it("keeps YouTube feeds in Videos view", () => {
    expect(
      getCorrectedSubscriptionView(
        createSubscription({
          feedId: "feed-2",
          view: FeedViewType.Videos,
        }),
      ),
    ).toBe(FeedViewType.Videos)
  })

  it("moves YouTube feeds into Videos view", () => {
    expect(
      getCorrectedSubscriptionView(
        createSubscription({
          feedId: "feed-2",
          view: FeedViewType.Articles,
        }),
      ),
    ).toBe(FeedViewType.Videos)
  })

  it("does not change non-YouTube subscriptions already outside Videos view", () => {
    expect(
      getCorrectedSubscriptionView(
        createSubscription({
          feedId: "feed-1",
          view: FeedViewType.Pictures,
        }),
      ),
    ).toBe(FeedViewType.Pictures)
  })
})
