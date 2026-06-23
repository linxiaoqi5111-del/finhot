import { FeedViewType } from "@follow/constants"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { apiContext, queryClientContext } from "../../context"
import type { FollowAPI } from "../../types"
import { useEntryStore } from "../entry/store"
import type { EntryModel } from "../entry/types"
import { collectionSyncService, useCollectionStore } from "./store"

const { collectionUpsertManyMock, recordFavoriteMock } = vi.hoisted(() => ({
  collectionUpsertManyMock: vi.fn(),
  recordFavoriteMock: vi.fn(),
}))

vi.mock("@follow/shared/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@follow/shared/constants")>()),
  LOCAL_RSS_MODE: true,
}))

vi.mock("@follow/database/services/collection", () => ({
  CollectionService: {
    deleteMany: vi.fn(),
    getCollectionAll: vi.fn(),
    reset: vi.fn(),
    upsertMany: collectionUpsertManyMock,
  },
}))

vi.mock("../behavior-event/store", () => ({
  behaviorEventSyncService: {
    recordFavorite: recordFavoriteMock,
  },
}))

const entry: EntryModel = {
  id: "entry-1",
  title: "Entry 1",
  url: "https://example.com/entry-1",
  content: null,
  readabilityContent: null,
  description: null,
  guid: "entry-1",
  author: null,
  authorUrl: null,
  authorAvatar: null,
  insertedAt: new Date("2026-01-01T00:00:00.000Z"),
  publishedAt: new Date("2026-01-01T00:00:00.000Z"),
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
}

describe("collectionSyncService", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    collectionUpsertManyMock.mockImplementation(() => Promise.resolve())
    recordFavoriteMock.mockImplementation(() => Promise.resolve())
    useCollectionStore.setState({ collections: {} })
    useEntryStore.setState({
      data: {
        [entry.id]: entry,
      },
      entryIdByView: {
        [FeedViewType.All]: new Set([entry.id]),
        [FeedViewType.Articles]: new Set([entry.id]),
        [FeedViewType.Audios]: new Set(),
        [FeedViewType.Notifications]: new Set(),
        [FeedViewType.Pictures]: new Set(),
        [FeedViewType.SocialMedia]: new Set(),
        [FeedViewType.Videos]: new Set(),
      },
      entryIdByCategory: {},
      entryIdByFeed: {
        [entry.feedId!]: new Set([entry.id]),
      },
      entryIdByInbox: {},
      entryIdByList: {},
      entryIdSet: new Set([entry.id]),
    })
    apiContext.provide({
      collections: {
        delete: vi.fn().mockRejectedValue(new Error("remote unavailable")),
        post: vi.fn().mockRejectedValue(new Error("remote unavailable")),
      },
    } as unknown as FollowAPI)
    queryClientContext.provide({
      invalidateQueries: vi.fn(),
    } as never)
  })

  it("keeps starred entries locally in local RSS mode when the remote API is unavailable", async () => {
    await expect(
      collectionSyncService.starEntry({
        entryId: entry.id,
        view: FeedViewType.Articles,
      }),
    ).resolves.toBeUndefined()

    expect(useCollectionStore.getState().collections[entry.id]).toMatchObject({
      entryId: entry.id,
      feedId: entry.feedId,
      view: FeedViewType.Articles,
    })
    expect(collectionUpsertManyMock).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          entryId: entry.id,
          feedId: entry.feedId,
          view: FeedViewType.Articles,
        }),
      ],
      undefined,
    )
  })

  it("removes starred entries locally in local RSS mode when the remote API is unavailable", async () => {
    useCollectionStore.setState({
      collections: {
        [entry.id]: {
          entryId: entry.id,
          feedId: entry.feedId,
          view: FeedViewType.Articles,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    })

    await expect(collectionSyncService.unstarEntry({ entryId: entry.id })).resolves.toBeUndefined()

    expect(useCollectionStore.getState().collections[entry.id]).toBeUndefined()
  })
})
