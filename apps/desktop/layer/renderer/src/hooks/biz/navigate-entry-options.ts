import { getReadonlyRoute } from "@follow/components/atoms/route.js"
import { FeedViewType } from "@follow/constants"

import {
  ROUTE_ENTRY_PENDING,
  ROUTE_FEED_IN_FOLDER,
  ROUTE_FEED_IN_INBOX,
  ROUTE_FEED_IN_LIST,
  ROUTE_FEED_PENDING,
} from "~/constants"

import { getTimelineIdByView } from "./useRouteParams"

export type NavigateEntryOptions = Partial<{
  timelineId: string
  feedId: string | null
  entryId: string | null
  view: FeedViewType
  folderName: string | null
  inboxId: string
  listId: string
  backPath: string
}>

export type ParsedNavigateEntryOptions = {
  feedId: string
  timelineId: string
  entryId: string
}

export const parseNavigateEntryOptions = (
  options: NavigateEntryOptions,
): ParsedNavigateEntryOptions => {
  const { entryId, feedId, view, folderName, inboxId, listId, timelineId } = options || {}
  const route = getReadonlyRoute()
  const { params } = route
  let finalFeedId = feedId || params.feedId || ROUTE_FEED_PENDING
  let finalTimelineId = timelineId || params.timelineId || ROUTE_FEED_PENDING
  const finalEntryId = entryId || ROUTE_ENTRY_PENDING

  if ("feedId" in options && feedId === null) {
    finalFeedId = ROUTE_FEED_PENDING
  }

  if (folderName) {
    finalFeedId = `${ROUTE_FEED_IN_FOLDER}${folderName}`
  }

  if (listId) {
    finalFeedId = `${ROUTE_FEED_IN_LIST}${listId}`
  }

  if (inboxId) {
    finalFeedId = `${ROUTE_FEED_IN_INBOX}${inboxId}`
  }

  finalFeedId = encodeURIComponent(finalFeedId)

  if (!timelineId && !listId && !folderName && !inboxId) {
    finalTimelineId = getTimelineIdByView(FeedViewType.All)
  } else if (typeof view === "number" && !timelineId) {
    finalTimelineId = getTimelineIdByView(view)
  }

  return {
    feedId: finalFeedId,
    timelineId: finalTimelineId,
    entryId: finalEntryId,
  }
}

export function getNavigateEntryPath(
  options: NavigateEntryOptions | ParsedNavigateEntryOptions,
): string {
  if (
    "feedId" in options &&
    "timelineId" in options &&
    "entryId" in options &&
    !("view" in options)
  ) {
    const parsed = options as ParsedNavigateEntryOptions
    return `/timeline/${parsed.timelineId}/${parsed.feedId}/${parsed.entryId}`
  }

  const { feedId, timelineId, entryId } = parseNavigateEntryOptions(options as NavigateEntryOptions)

  return `/timeline/${timelineId}/${feedId}/${entryId}`
}
