import { FeedViewType } from "@follow/constants"
import { beforeEach, describe, expect, test, vi } from "vitest"

import type { EntryModel } from "../entry/types"
import {
  entryQualityScoreActions,
  entryQualityScoreSyncService,
} from "../entry-quality-score/store"
import {
  applyLocalActionRulesToEntry,
  loadLocalActionRules,
  runLocalActionSideEffects,
} from "./local"
import { actionActions, actionSyncService, useActionStore } from "./store"

const createLocalStorageMock = () => {
  const store = new Map<string, string>()
  return {
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
  } satisfies Storage
}

const createEntry = (overrides: Partial<EntryModel> = {}): EntryModel => ({
  id: "entry-1",
  guid: "entry-1-guid",
  title: "AI post from Cai",
  url: "https://example.com/posts/ai",
  content: "Read this old content",
  description: "old description",
  author: "Cai",
  insertedAt: new Date("2026-01-01T00:00:00.000Z"),
  publishedAt: new Date("2026-01-01T00:00:00.000Z"),
  feedId: "feed-1",
  read: false,
  ...overrides,
})

describe("local action rules", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: createLocalStorageMock(),
      configurable: true,
    })
    vi.clearAllMocks()
    localStorage.clear()
    useActionStore.setState({
      rules: [],
      isDirty: false,
    })
  })

  test("saves and loads rules locally without calling the remote API", async () => {
    actionActions.updateRules([
      {
        index: 0,
        name: "Enable readability for Hacker News",
        condition: [
          [
            {
              field: "feed_url",
              operator: "contains",
              value: "rsshub://hackernews",
            },
          ],
        ],
        result: {
          readability: true,
        },
      },
    ])

    await actionSyncService.saveRules()

    useActionStore.setState({
      rules: [],
      isDirty: false,
    })

    await actionSyncService.fetchRules()

    expect(useActionStore.getState().isDirty).toBe(false)
    expect(loadLocalActionRules()).toHaveLength(1)
    expect(useActionStore.getState().rules[0]?.result.readability).toBe(true)
  })

  test("matches OR condition groups and merges entry settings actions", () => {
    const result = applyLocalActionRulesToEntry(createEntry(), {
      feed: {
        id: "feed-1",
        type: "feed",
        title: "Hacker News",
        url: "rsshub://hackernews",
        siteUrl: "https://news.ycombinator.com",
      },
      subscription: {
        view: FeedViewType.Articles,
        category: "Tech",
      },
      view: FeedViewType.Articles,
      rules: [
        {
          index: 0,
          name: "Default readability",
          condition: [
            [
              {
                field: "feed_url",
                operator: "contains",
                value: "s.baoyu.io/feed.xml",
              },
            ],
            [
              {
                field: "feed_url",
                operator: "contains",
                value: "rsshub://hackernews",
              },
            ],
          ],
          result: {
            readability: true,
            summary: true,
            sourceContent: true,
          },
        },
      ],
    })

    expect(result.blocked).toBe(false)
    expect(result.entry.settings).toMatchObject({
      readability: true,
      summary: true,
      sourceContent: true,
    })
  })

  test("requires all conditions inside a group to match", () => {
    const matched = applyLocalActionRulesToEntry(createEntry(), {
      feed: {
        id: "feed-1",
        type: "feed",
        title: "Example Feed",
        url: "https://example.com/feed.xml",
      },
      view: FeedViewType.Articles,
      rules: [
        {
          index: 0,
          name: "AI by Cai",
          condition: [
            [
              {
                field: "entry_title",
                operator: "contains",
                value: "AI",
              },
              {
                field: "entry_author",
                operator: "eq",
                value: "Cai",
              },
            ],
          ],
          result: {
            translation: true,
          },
        },
      ],
    })

    const missed = applyLocalActionRulesToEntry(createEntry({ author: "Other" }), {
      feed: {
        id: "feed-1",
        type: "feed",
        title: "Example Feed",
        url: "https://example.com/feed.xml",
      },
      view: FeedViewType.Articles,
      rules: matched.matchedRules,
    })

    expect(matched.entry.settings?.translation).toBe(true)
    expect(missed.entry.settings?.translation).toBeUndefined()
  })

  test("applies silence, block, star, rewrite rules, notifications, and webhooks locally", () => {
    const result = applyLocalActionRulesToEntry(createEntry(), {
      feed: {
        id: "feed-1",
        type: "feed",
        title: "Example Feed",
        url: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
      },
      view: FeedViewType.Articles,
      rules: [
        {
          index: 0,
          name: "Local side effects",
          condition: [],
          result: {
            silence: true,
            block: true,
            star: true,
            newEntryNotification: true,
            webhooks: ["https://webhook.example.com/folo"],
            rewriteRules: [
              {
                from: "old",
                to: "new",
              },
            ],
          },
        },
      ],
    })

    expect(result.entry.read).toBe(true)
    expect(result.blocked).toBe(true)
    expect(result.starred).toBe(true)
    expect(result.shouldNotify).toBe(true)
    expect(result.webhooks).toEqual(["https://webhook.example.com/folo"])
    expect(result.entry.content).toBe("Read this new content")
    expect(result.entry.description).toBe("new description")
  })

  test("flags skipEnrichment when a matching rule opts out of AI enrichment", () => {
    const matched = applyLocalActionRulesToEntry(createEntry(), {
      feed: {
        id: "feed-1",
        type: "feed",
        title: "Cninfo L3",
        url: "http://localhost:8787/l3-hard-delta.xml",
      },
      view: FeedViewType.Articles,
      rules: [
        {
          index: 0,
          name: "No AI for cninfo",
          condition: [
            [
              {
                field: "feed_url",
                operator: "contains",
                value: "l3-hard-delta",
              },
            ],
          ],
          result: {
            skipEnrichment: true,
          },
        },
      ],
    })

    const unmatched = applyLocalActionRulesToEntry(createEntry(), {
      feed: {
        id: "feed-2",
        type: "feed",
        title: "Other Feed",
        url: "https://example.com/feed.xml",
      },
      view: FeedViewType.Articles,
      rules: matched.matchedRules,
    })

    expect(matched.skipEnrichment).toBe(true)
    expect(matched.blocked).toBe(false)
    expect(unmatched.skipEnrichment).toBe(false)
  })

  test("runs readability side effect for matching readability rules", async () => {
    const fetchReadabilityContent = vi.fn().mockImplementation(async () => {})
    const result = applyLocalActionRulesToEntry(createEntry(), {
      feed: {
        id: "feed-1",
        type: "feed",
        title: "Hacker News",
        url: "rsshub://hackernews",
        siteUrl: "https://news.ycombinator.com",
      },
      rules: [
        {
          index: 0,
          name: "Enable readability",
          condition: [],
          result: {
            readability: true,
          },
        },
      ],
    })

    await runLocalActionSideEffects(result, { fetchReadabilityContent })

    expect(fetchReadabilityContent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "entry-1",
        settings: {
          readability: true,
        },
      }),
    )
  })

  test("runs readability quality score side effect for matching rules", async () => {
    const fetchReadabilityContent = vi.fn().mockImplementation(async () => {})
    const deleteMany = vi
      .spyOn(entryQualityScoreActions, "deleteMany")
      .mockImplementation(async () => {})
    const generateScore = vi
      .spyOn(entryQualityScoreSyncService, "generateScore")
      .mockImplementation(async () => null)

    const result = applyLocalActionRulesToEntry(createEntry(), {
      feed: {
        id: "feed-1",
        type: "feed",
        title: "Hacker News",
        url: "rsshub://hackernews",
        siteUrl: "https://news.ycombinator.com",
      },
      rules: [
        {
          index: 0,
          name: "Score readability",
          condition: [],
          result: {
            readabilityQualityScore: true,
          },
        },
      ],
    })

    await runLocalActionSideEffects(result, {
      actionLanguage: "en",
      fetchReadabilityContent,
    })

    expect(fetchReadabilityContent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "entry-1",
      }),
    )
    expect(deleteMany).toHaveBeenCalledWith(["entry-1"])
    expect(generateScore).toHaveBeenCalledWith({
      entryId: "entry-1",
      actionLanguage: "en",
      target: "readabilityContent",
    })
  })
})
