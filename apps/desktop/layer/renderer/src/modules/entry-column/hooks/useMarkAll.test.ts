import { FeedViewType } from "@follow/constants"
import { useCollectionStore } from "@follow/store/collection/store"
import { unreadSyncService } from "@follow/store/unread/store"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { jotaiStore } from "~/lib/jotai"
import {
  selectedStarredGroupAtom,
  STARRED_GROUP_ALL,
  starredGroupAssignmentsAtom,
} from "~/modules/starred-groups/store"

import { markAllByRoute } from "./useMarkAll"

vi.mock("@follow/store/subscription/getter", () => ({
  getCategoryFeedIds: () => [],
}))

vi.mock("@follow/store/unread/store", () => ({
  unreadSyncService: {
    markBatchAsRead: vi.fn(),
    markEntriesAsRead: vi.fn(),
  },
}))

vi.mock("~/atoms/settings/general", () => ({
  getGeneralSettings: () => ({
    hidePrivateSubscriptionsInTimeline: false,
  }),
}))

describe("markAllByRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCollectionStore.setState({ collections: {} })
    jotaiStore.set(selectedStarredGroupAtom, STARRED_GROUP_ALL)
    jotaiStore.set(starredGroupAssignmentsAtom, {})
  })

  it("marks starred collection entries as read without treating collections as a feed id", async () => {
    useCollectionStore.setState({
      collections: {
        "entry-1": {
          entryId: "entry-1",
          feedId: "feed-1",
          view: FeedViewType.Articles,
          createdAt: "2026-06-12T00:00:00.000Z",
        },
        "entry-2": {
          entryId: "entry-2",
          feedId: "feed-2",
          view: FeedViewType.Pictures,
          createdAt: "2026-06-13T00:00:00.000Z",
        },
      },
    })

    await markAllByRoute({
      feedId: "collections",
      view: FeedViewType.All,
      isCollection: true,
    })

    expect(unreadSyncService.markEntriesAsRead).toHaveBeenCalledWith(["entry-2", "entry-1"])
    expect(unreadSyncService.markBatchAsRead).not.toHaveBeenCalled()
  })
})
