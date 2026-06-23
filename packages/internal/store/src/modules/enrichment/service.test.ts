import { FeedViewType } from "@follow/constants"
import { beforeEach, describe, expect, test, vi } from "vitest"

import { useEntryStore } from "../entry/store"
import type { EntryModel } from "../entry/types"
import { entryQualityScoreActions } from "../entry-quality-score/store"
import { useSubscriptionStore } from "../subscription/store"
import { useSummaryStore } from "../summary/store"
import { entryEnrichmentService } from "./service"
import { useEnrichmentStatusStore } from "./store"

const generateSummaryMock = vi.fn()

vi.mock("../summary/store", async () => {
  const actual = await vi.importActual<typeof import("../summary/store")>("../summary/store")

  return {
    ...actual,
    summarySyncService: {
      ...actual.summarySyncService,
      generateSummary: (...args: Parameters<typeof actual.summarySyncService.generateSummary>) =>
        generateSummaryMock(...args),
    },
  }
})

const createEntry = (id: string, feedId = "feed-a"): EntryModel => ({
  id,
  guid: `${id}-guid`,
  feedId,
  title: `${id} title`,
  insertedAt: new Date("2026-01-01T00:00:00.000Z"),
  publishedAt: new Date("2026-01-01T00:00:00.000Z"),
})

const createEmptyViewSets = () => ({
  [FeedViewType.All]: new Set<string>(),
  [FeedViewType.Articles]: new Set<string>(),
  [FeedViewType.Audios]: new Set<string>(),
  [FeedViewType.Notifications]: new Set<string>(),
  [FeedViewType.Pictures]: new Set<string>(),
  [FeedViewType.SocialMedia]: new Set<string>(),
  [FeedViewType.Videos]: new Set<string>(),
})

const setSubscribedFeedIds = (feedIds: string[]) => {
  const feedIdSet = new Set(feedIds)
  useSubscriptionStore.setState({
    data: Object.fromEntries(
      feedIds.map((feedId) => [
        feedId,
        {
          feedId,
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
      ]),
    ),
    feedIdByView: {
      ...createEmptyViewSets(),
      [FeedViewType.All]: new Set(feedIdSet),
      [FeedViewType.Articles]: new Set(feedIdSet),
    },
    listIdByView: createEmptyViewSets(),
    categories: createEmptyViewSets(),
    subscriptionIdSet: new Set(feedIds),
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
}

describe("entryEnrichmentService", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    generateSummaryMock.mockResolvedValue("summary text")
    setSubscribedFeedIds(["feed-a", "feed-b"])

    useEntryStore.setState({
      data: {
        "entry-1": createEntry("entry-1"),
        "entry-2": createEntry("entry-2"),
      },
    })
    useSummaryStore.setState({
      data: {},
      generatingStatus: {},
    })
    useEnrichmentStatusStore.setState({
      snapshot: {
        queueLength: 0,
        pendingCount: 0,
        isProcessing: false,
        activeJobs: [],
        lastError: null,
        updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      },
    })
  })

  test("retryEntry requeues a single entry", async () => {
    useEntryStore.setState({
      data: {
        "entry-retry": createEntry("entry-retry"),
      },
    })

    const result = entryEnrichmentService.retryEntry({
      entryId: "entry-retry",
      actionLanguage: "en",
    })

    expect(result).toEqual({ ok: true })
    expect(entryEnrichmentService.isEntryInPipeline("entry-retry")).toBe(true)
  })

  test("enqueues missing summaries from ingest and drains the queue", async () => {
    entryEnrichmentService.enqueueFromIngest({
      entryIds: ["entry-1", "entry-2"],
      actionLanguage: "en",
    })

    await vi.waitFor(() => {
      expect(generateSummaryMock).toHaveBeenCalledTimes(2)
    })

    expect(generateSummaryMock).toHaveBeenCalledWith({
      entryId: "entry-1",
      target: "content",
      actionLanguage: "en",
    })
  })

  test("skips entries that already have summaries", async () => {
    useSummaryStore.setState({
      data: {
        "entry-1": {
          en: {
            summary: "existing",
            readabilitySummary: null,
            lastAccessed: Date.now(),
          },
        },
      },
      generatingStatus: {},
    })

    entryEnrichmentService.enqueueFromIngest({
      entryIds: ["entry-1", "entry-2"],
      actionLanguage: "en",
    })

    await vi.waitFor(() => {
      expect(generateSummaryMock).toHaveBeenCalledTimes(1)
    })

    expect(generateSummaryMock).toHaveBeenCalledWith({
      entryId: "entry-2",
      target: "content",
      actionLanguage: "en",
    })
  })

  test("skips entries from feeds that are no longer subscribed", async () => {
    setSubscribedFeedIds(["feed-a"])
    useEntryStore.setState({
      data: {
        "entry-1": createEntry("entry-1", "feed-a"),
        "entry-2": createEntry("entry-2", "feed-b"),
      },
    })

    entryEnrichmentService.enqueueFromIngest({
      entryIds: ["entry-1", "entry-2"],
      actionLanguage: "en",
    })

    await vi.waitFor(() => {
      expect(generateSummaryMock).toHaveBeenCalledTimes(1)
    })

    expect(generateSummaryMock).toHaveBeenCalledWith({
      entryId: "entry-1",
      target: "content",
      actionLanguage: "en",
    })
  })

  test("cancels queued entries from unsubscribed feeds", async () => {
    const resolveActiveJobs = new Map<string, (value: string) => void>()
    const entries = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => {
        const id = `entry-${index + 1}`
        return [id, createEntry(id, index < 2 ? "feed-a" : "feed-b")]
      }),
    )

    useEntryStore.setState({ data: entries })
    generateSummaryMock.mockImplementation(({ entryId }) => {
      if (entryId === "entry-1" || entryId === "entry-2") {
        return new Promise((resolve) => {
          resolveActiveJobs.set(entryId, resolve)
        })
      }

      return Promise.resolve("summary text")
    })

    entryEnrichmentService.enqueueFromIngest({
      entryIds: Object.keys(entries),
      actionLanguage: "en",
    })

    await vi.waitFor(() => {
      expect(generateSummaryMock).toHaveBeenCalledTimes(2)
    })

    setSubscribedFeedIds(["feed-a"])
    expect(entryEnrichmentService.cancelEntriesByFeedIds(["feed-b"])).toBeGreaterThan(0)

    resolveActiveJobs.get("entry-1")?.("summary text")
    resolveActiveJobs.get("entry-2")?.("summary text")

    await vi.waitFor(() => {
      expect(useEnrichmentStatusStore.getState().snapshot.isProcessing).toBe(false)
    })

    expect(generateSummaryMock.mock.calls.map(([options]) => options.entryId)).toEqual([
      "entry-1",
      "entry-2",
    ])
  })

  test("retries entries after job timeout", async () => {
    vi.useFakeTimers()

    generateSummaryMock.mockImplementation(
      () =>
        new Promise(() => {
          // Never resolves to simulate a hung BYOK request.
        }),
    )

    entryEnrichmentService.enqueueFromIngest({
      entryIds: ["entry-1"],
      actionLanguage: "en",
    })

    await vi.advanceTimersByTimeAsync(90_000)

    const { lastError } = useEnrichmentStatusStore.getState().snapshot
    expect(lastError).toMatchObject({
      entryId: "entry-1",
      phase: "summary",
      errorCode: "enrichment_timeout",
      errorKey: "entry-1:enrichment_timeout",
    })

    entryEnrichmentService.enqueueFromIngest({
      entryIds: ["entry-1"],
      actionLanguage: "en",
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(generateSummaryMock).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })

  test("rescoring selected feeds only clears scores for those feeds", async () => {
    const deleteManySpy = vi.spyOn(entryQualityScoreActions, "deleteMany").mockResolvedValue()

    useEntryStore.setState({
      data: {
        "entry-1": createEntry("entry-1", "feed-a"),
        "entry-2": createEntry("entry-2", "feed-b"),
      },
    })

    entryQualityScoreActions.upsertManyInSession([
      {
        entryId: "entry-1",
        data: {
          quality_score: 80,
          confidence: 0.9,
          content_types: { Research: 1 },
          scores: {
            information_gain: 4,
            depth: 4,
            evidence: 4,
            actionability: 4,
            originality: 4,
            signal_density: 4,
          },
          positive_reasons: [],
          negative_reasons: [],
          summary: "entry-1",
        },
      },
      {
        entryId: "entry-2",
        data: {
          quality_score: 70,
          confidence: 0.8,
          content_types: { News: 1 },
          scores: {
            information_gain: 3,
            depth: 3,
            evidence: 3,
            actionability: 3,
            originality: 3,
            signal_density: 3,
          },
          positive_reasons: [],
          negative_reasons: [],
          summary: "entry-2",
        },
      },
    ])

    const count = await entryEnrichmentService.rescoreFeeds({
      feedIds: ["feed-a"],
      actionLanguage: "en",
    })

    expect(count).toBe(1)
    expect(deleteManySpy).toHaveBeenCalledWith(["entry-1"])
    deleteManySpy.mockRestore()
  })
})
