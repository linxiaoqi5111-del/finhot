import { FeedViewType } from "@follow/constants"
import { useEffect, useRef } from "react"

import { ROUTE_ENTRY_PENDING, ROUTE_FEED_PENDING } from "~/constants"

import { useNavigateEntry } from "./useNavigateEntry"
import { useRouteParamsSelector } from "./useRouteParams"

/**
 * Keep the desktop timeline on the unified "All" route.
 * Subscription metadata may still use Articles/Videos/etc. internally.
 */
export const useNormalizeTimelineRoute = () => {
  const navigate = useNavigateEntry()
  const route = useRouteParamsSelector((state) => ({
    view: state.view,
    feedId: state.feedId,
    entryId: state.entryId,
    listId: state.listId,
    smartFeed: state.smartFeed,
    topicLabel: state.topicLabel,
    myTopicId: state.myTopicId,
    isCollection: state.isCollection,
  }))
  const isNormalizingRef = useRef(false)

  useEffect(() => {
    if (route.view === FeedViewType.All) {
      isNormalizingRef.current = false
      return
    }
    if (
      route.listId ||
      route.smartFeed ||
      route.topicLabel ||
      route.myTopicId ||
      route.isCollection
    ) {
      return
    }
    if (isNormalizingRef.current) return

    isNormalizingRef.current = true
    navigate({
      view: FeedViewType.All,
      feedId: route.feedId === ROUTE_FEED_PENDING ? null : route.feedId,
      entryId: !route.entryId || route.entryId === ROUTE_ENTRY_PENDING ? null : route.entryId,
    })
  }, [navigate, route])
}
