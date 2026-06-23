import { FeedViewType } from "@follow/constants"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { apiContext, readabilityContentFetcherContext } from "../../context"
import type { FollowAPI } from "../../types"
import { useActionStore } from "../action/store"
import { useCollectionStore } from "../collection/store"
import { useFeedStore } from "../feed/store"
import { entrySyncServices, useEntryStore } from "./store"

const {
  collectionDeleteManyMock,
  collectionUpsertManyMock,
  entryGetManyMock,
  entryPatchMock,
  entryUpsertManyMock,
  feedUpsertManyMock,
} = vi.hoisted(() => ({
  collectionDeleteManyMock: vi.fn(),
  collectionUpsertManyMock: vi.fn(),
  entryGetManyMock: vi.fn(),
  entryPatchMock: vi.fn(),
  entryUpsertManyMock: vi.fn(),
  feedUpsertManyMock: vi.fn(),
}))

vi.mock("@follow/database/services/collection", () => ({
  CollectionService: {
    deleteMany: collectionDeleteManyMock,
    getCollectionAll: vi.fn(),
    reset: vi.fn(),
    upsertMany: collectionUpsertManyMock,
  },
}))

vi.mock("@follow/database/services/entry", () => ({
  EntryService: {
    getEntryMany: entryGetManyMock,
    getEntriesToHydrate: vi.fn(),
    patch: entryPatchMock,
    upsertMany: entryUpsertManyMock,
  },
}))

vi.mock("@follow/database/services/feed", () => ({
  FEED_EXTRA_DATA_KEYS: [],
  FeedService: {
    getFeedAll: vi.fn(),
    reset: vi.fn(),
    upsertMany: feedUpsertManyMock,
  },
}))

const createCollectionResponseItem = (index: number) => ({
  read: true,
  feeds: {
    id: "feed-1",
    title: "Feed",
    url: "https://example.com/feed.xml",
    image: null,
    description: null,
    ownerUserId: null,
    errorAt: null,
    errorMessage: null,
    siteUrl: "https://example.com",
  },
  entries: {
    id: `entry-${index}`,
    title: `Entry ${index}`,
    url: `https://example.com/${index}`,
    description: null,
    guid: `entry-${index}`,
    author: null,
    authorUrl: null,
    authorAvatar: null,
    insertedAt: "2026-03-01T00:00:00.000Z",
    publishedAt: "2026-02-01T00:00:00.000Z",
    media: null,
    categories: null,
    attachments: null,
    extra: null,
    language: null,
  },
  collections: {
    createdAt: `2026-03-${String(index).padStart(2, "0")}T00:00:00.000Z`,
  },
})

describe("entrySyncServices.fetchEntries", () => {
  const listEntriesMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    entryGetManyMock.mockResolvedValue([])
    entryPatchMock.mockImplementation(async () => {})
    entryUpsertManyMock.mockImplementation(async () => {})
    collectionUpsertManyMock.mockImplementation(async () => {})
    collectionDeleteManyMock.mockImplementation(async () => {})
    feedUpsertManyMock.mockImplementation(async () => {})

    useEntryStore.setState({
      data: {},
      entryIdByView: {
        [FeedViewType.All]: new Set(),
        [FeedViewType.Articles]: new Set(),
        [FeedViewType.Audios]: new Set(),
        [FeedViewType.Notifications]: new Set(),
        [FeedViewType.Pictures]: new Set(),
        [FeedViewType.SocialMedia]: new Set(),
        [FeedViewType.Videos]: new Set(),
      },
      entryIdByCategory: {},
      entryIdByFeed: {},
      entryIdByInbox: {},
      entryIdByList: {},
      entryIdSet: new Set(),
    })
    useCollectionStore.setState({ collections: {} })
    useFeedStore.setState({ feeds: {} })
    useActionStore.setState({ rules: [], isDirty: false })
    readabilityContentFetcherContext.provide()
    apiContext.provide({
      entries: {
        list: listEntriesMock,
        readability: vi.fn().mockResolvedValue({
          data: {
            content: "<article>Readability content</article>",
          },
        }),
      },
    } as unknown as FollowAPI)
  })

  it("keeps known collection entries when the first collection page can have more pages", async () => {
    useCollectionStore.setState({
      collections: Object.fromEntries(
        Array.from({ length: 25 }, (_, index) => {
          const entryId = `entry-${index + 1}`
          return [
            entryId,
            {
              entryId,
              feedId: "feed-1",
              view: FeedViewType.Articles,
              createdAt: `2026-03-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
            },
          ]
        }),
      ),
    })
    listEntriesMock.mockResolvedValue({
      data: Array.from({ length: 20 }, (_, index) => createCollectionResponseItem(index + 6)),
    })

    await entrySyncServices.fetchEntries({
      feedId: "collections",
      view: FeedViewType.Articles,
      limit: 20,
    })

    expect(Object.keys(useCollectionStore.getState().collections)).toHaveLength(25)
    expect(useCollectionStore.getState().collections["entry-1"]).toBeDefined()
  })

  it("applies local action rules to fetched entries", async () => {
    useActionStore.setState({
      isDirty: false,
      rules: [
        {
          index: 0,
          name: "Block noisy entries",
          condition: [
            [
              {
                field: "entry_title",
                operator: "contains",
                value: "Block",
              },
            ],
          ],
          result: {
            block: true,
          },
        },
        {
          index: 1,
          name: "Prepare useful entries",
          condition: [
            [
              {
                field: "entry_title",
                operator: "contains",
                value: "Keep",
              },
            ],
          ],
          result: {
            readability: true,
            summary: true,
            silence: true,
            star: true,
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
    listEntriesMock.mockResolvedValue({
      data: [
        {
          ...createCollectionResponseItem(1),
          read: false,
          entries: {
            ...createCollectionResponseItem(1).entries,
            title: "Block this entry",
            description: "old blocked description",
          },
        },
        {
          ...createCollectionResponseItem(2),
          read: false,
          entries: {
            ...createCollectionResponseItem(2).entries,
            title: "Keep this old entry",
            description: "old useful description",
          },
        },
      ],
    })

    await entrySyncServices.fetchEntries({
      view: FeedViewType.Articles,
      limit: 20,
    })

    expect(useEntryStore.getState().data["entry-1"]).toBeUndefined()
    expect(useEntryStore.getState().data["entry-2"]).toMatchObject({
      title: "Keep this new entry",
      description: "new useful description",
      read: true,
      settings: {
        readability: true,
        summary: true,
      },
    })
    expect(useCollectionStore.getState().collections["entry-2"]).toMatchObject({
      entryId: "entry-2",
      feedId: "feed-1",
      view: FeedViewType.Articles,
    })
  })

  it("returns and stores fetched readability content only when content exists", async () => {
    const readabilityMock = vi.fn().mockResolvedValue({
      data: {
        content: "<article>Full article</article>",
      },
    })
    apiContext.provide({
      entries: {
        list: listEntriesMock,
        readability: readabilityMock,
      },
    } as unknown as FollowAPI)
    useEntryStore.setState({
      data: {
        "entry-readable": {
          id: "entry-readable",
          title: "Readable entry",
          url: "https://example.com/readable",
          content: null,
          readabilityContent: null,
          description: null,
          guid: "entry-readable",
          author: null,
          authorUrl: null,
          authorAvatar: null,
          insertedAt: new Date("2026-03-01T00:00:00.000Z"),
          publishedAt: new Date("2026-02-01T00:00:00.000Z"),
          media: null,
          categories: null,
          attachments: null,
          extra: null,
          language: null,
          feedId: "feed-1",
          inboxHandle: null,
          read: false,
          sources: null,
          settings: null,
        },
      },
      entryIdSet: new Set(["entry-readable"]),
    })

    await expect(entrySyncServices.fetchEntryReadabilityContent("entry-readable")).resolves.toBe(
      "<article>Full article</article>",
    )

    expect(useEntryStore.getState().data["entry-readable"]?.readabilityContent).toBe(
      "<article>Full article</article>",
    )
    expect(entryPatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "entry-readable",
        readabilityContent: "<article>Full article</article>",
      }),
    )
  })

  it("returns null when readability fetch has no content", async () => {
    apiContext.provide({
      entries: {
        list: listEntriesMock,
        readability: vi.fn().mockResolvedValue({
          data: {
            content: null,
          },
        }),
      },
    } as unknown as FollowAPI)
    useEntryStore.setState({
      data: {
        "entry-empty": {
          id: "entry-empty",
          title: "Empty entry",
          url: "https://example.com/empty",
          content: null,
          readabilityContent: null,
          description: null,
          guid: "entry-empty",
          author: null,
          authorUrl: null,
          authorAvatar: null,
          insertedAt: new Date("2026-03-01T00:00:00.000Z"),
          publishedAt: new Date("2026-02-01T00:00:00.000Z"),
          media: null,
          categories: null,
          attachments: null,
          extra: null,
          language: null,
          feedId: "feed-1",
          inboxHandle: null,
          read: false,
          sources: null,
          settings: null,
        },
      },
      entryIdSet: new Set(["entry-empty"]),
    })

    await expect(entrySyncServices.fetchEntryReadabilityContent("entry-empty")).resolves.toBeNull()
    expect(useEntryStore.getState().data["entry-empty"]?.readabilityContent).toBeNull()
  })
})
