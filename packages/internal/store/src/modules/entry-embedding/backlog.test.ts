import { FeedViewType } from "@follow/constants"
import { beforeEach, describe, expect, test } from "vitest"

import { useEntryStore } from "../entry/store"
import type { EntryModel } from "../entry/types"
import { useSubscriptionStore } from "../subscription/store"
import { entryNeedsEmbedding, getEmbeddingCoverageStats } from "./backlog"
import { useEntryEmbeddingStore } from "./store"

const createEntry = (id: string, overrides: Partial<EntryModel> = {}): EntryModel =>
  ({
    id,
    guid: `${id}-guid`,
    insertedAt: new Date("2026-01-01T00:00:00.000Z"),
    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
    feedId: "feed-a",
    title: "Title",
    description: "Summary",
    ...overrides,
  }) as EntryModel

const createEmptyViewSets = () => ({
  [FeedViewType.All]: new Set<string>(),
  [FeedViewType.Articles]: new Set<string>(),
  [FeedViewType.Audios]: new Set<string>(),
  [FeedViewType.Notifications]: new Set<string>(),
  [FeedViewType.Pictures]: new Set<string>(),
  [FeedViewType.SocialMedia]: new Set<string>(),
  [FeedViewType.Videos]: new Set<string>(),
})

describe("embedding backlog", () => {
  beforeEach(() => {
    useSubscriptionStore.setState({
      data: {
        "feed-a": {
          feedId: "feed-a",
          listId: null,
          inboxId: null,
          userId: "user",
          view: FeedViewType.Articles,
          isPrivate: false,
          hideFromTimeline: null,
          title: null,
          category: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          type: "feed",
        },
      },
      feedIdByView: {
        ...createEmptyViewSets(),
        [FeedViewType.All]: new Set(["feed-a"]),
        [FeedViewType.Articles]: new Set(["feed-a"]),
      },
      listIdByView: createEmptyViewSets(),
      categories: createEmptyViewSets(),
      subscriptionIdSet: new Set(["feed-a"]),
      categoryOpenStateByView: {
        [FeedViewType.All]: {},
        [FeedViewType.Articles]: {},
        [FeedViewType.Audios]: {},
        [FeedViewType.Notifications]: {},
        [FeedViewType.Pictures]: {},
        [FeedViewType.SocialMedia]: {},
        [FeedViewType.Videos]: {},
      },
    })
    useEntryStore.setState({
      data: {
        "entry-missing": createEntry("entry-missing"),
        "entry-covered": createEntry("entry-covered"),
        "entry-read": createEntry("entry-read", { read: true }),
      },
    })
    useEntryEmbeddingStore.setState({
      data: {
        "entry-covered": {
          preset: "siliconflow",
          provider: "siliconflow",
          model: "BAAI/bge-m3",
          dimension: 1024,
          vector: [0.1],
          embedded_at: "2026-01-01T00:00:00.000Z",
          sourceHash: "deadbeef",
        },
      },
    })
  })

  test("counts missing and stale entries as backlog", () => {
    expect(entryNeedsEmbedding("entry-missing")).toBe(true)
    expect(entryNeedsEmbedding("entry-covered")).toBe(true)
    expect(entryNeedsEmbedding("entry-read")).toBe(false)

    const stats = getEmbeddingCoverageStats(() => false)
    expect(stats.eligibleCount).toBe(2)
    expect(stats.backlogCount).toBe(2)
    expect(stats.coveredCount).toBe(0)
  })
})
