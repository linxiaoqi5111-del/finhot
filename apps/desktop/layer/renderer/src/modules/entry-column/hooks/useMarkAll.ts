import { FeedViewType } from "@follow/constants"
import { useCollectionStore } from "@follow/store/collection/store"
import { getCategoryFeedIds } from "@follow/store/subscription/getter"
import { unreadSyncService } from "@follow/store/unread/store"

import { getGeneralSettings } from "~/atoms/settings/general"
import { jotaiStore } from "~/lib/jotai"
import {
  doesEntryMatchStarredGroupFilter,
  selectedStarredGroupAtom,
  starredGroupAssignmentsAtom,
} from "~/modules/starred-groups/store"

export type MarkAllFilter =
  | {
      startTime: number
      endTime: number
    }
  | {
      insertedBefore: number
    }

export const markAllByRoute = async (
  data: {
    feedId?: string | undefined
    view: FeedViewType
    inboxId?: string | undefined
    listId?: string | undefined

    isAllFeeds?: boolean
    isCollection?: boolean
  },
  time?: MarkAllFilter,
) => {
  const { feedId, view, inboxId, listId, isAllFeeds, isCollection } = data
  const folderIds = getCategoryFeedIds(feedId, view)

  if (!feedId) return

  if (isCollection) {
    const selectedGroupId = jotaiStore.get(selectedStarredGroupAtom)
    const assignments = jotaiStore.get(starredGroupAssignmentsAtom)
    const entryIds = Object.values(useCollectionStore.getState().collections)
      .filter((collection) => view === FeedViewType.All || collection.view === view)
      .filter((collection) =>
        doesEntryMatchStarredGroupFilter({
          entryId: collection.entryId,
          selectedGroupId,
          assignments,
        }),
      )
      .sort((a, b) => (new Date(a.createdAt ?? 0) > new Date(b.createdAt ?? 0) ? -1 : 1))
      .map((collection) => collection.entryId)

    if (entryIds.length > 0) {
      await unreadSyncService.markEntriesAsRead(entryIds)
    }
    return
  }

  const { hidePrivateSubscriptionsInTimeline: excludePrivate } = getGeneralSettings()
  if (typeof feedId === "number" || isAllFeeds) {
    unreadSyncService.markBatchAsRead({
      view,
      time,
      excludePrivate,
    })
  } else if (inboxId) {
    unreadSyncService.markBatchAsRead({
      filter: {
        inboxId,
      },
      view,
      time,
      excludePrivate,
    })
  } else if (listId) {
    unreadSyncService.markBatchAsRead({
      filter: {
        listId,
      },
      view,
      time,
      excludePrivate,
    })
  } else if (folderIds?.length) {
    unreadSyncService.markBatchAsRead({
      filter: {
        feedIdList: folderIds,
      },
      view,
      time,
      excludePrivate,
    })
  } else if (feedId) {
    unreadSyncService.markBatchAsRead({
      filter: {
        feedIdList: feedId?.split(","),
      },
      view,
      time,
      excludePrivate,
    })
  }
}
