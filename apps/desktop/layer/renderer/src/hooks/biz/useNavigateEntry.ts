import { getReadonlyRoute, getStableRouterNavigate } from "@follow/components/atoms/route.js"
import { useMobile } from "@follow/components/hooks/useMobile.js"
import { useSheetContext } from "@follow/components/ui/sheet/context.js"
import { getEntry } from "@follow/store/entry/getter"
import { tracker } from "@follow/tracker"
import { useCallback } from "react"
import { toast } from "sonner"

import { disableShowAISummaryOnce } from "~/atoms/ai-summary"
import { setPreviewBackPath } from "~/atoms/preview"
import { resetShowSourceContent } from "~/atoms/source-content"
import { ROUTE_ENTRY_PENDING, ROUTE_FEED_PENDING } from "~/constants"

import type { NavigateEntryOptions } from "./navigate-entry-options"
import { getNavigateEntryPath, parseNavigateEntryOptions } from "./navigate-entry-options"
import { useRouteParamsSelector } from "./useRouteParams"

export type { NavigateEntryOptions } from "./navigate-entry-options"
export { getNavigateEntryPath, parseNavigateEntryOptions } from "./navigate-entry-options"

/**
 * @description a hook to navigate to `feedId`, `entryId`, add search for `view`, `level`
 */
export const useNavigateEntry = () => {
  const sheetContext = useSheetContext()
  const isMobile = useMobile()
  return useCallback(
    (options: NavigateEntryOptions) => {
      navigateEntry(options)
      if (isMobile && sheetContext) {
        sheetContext.dismiss()
      }
    },
    [isMobile, sheetContext],
  )
}

/*
 * /timeline/:timelineId/:feedId/:entryId
 * timelineId: articles | social-media | view-1 (legacy) | ...
 * feedId: xxx, folder-xxx, list-xxx, inbox-xxx
 * entryId: xxx
 */
export const navigateEntry = (options: NavigateEntryOptions) => {
  const parsedOptions = parseNavigateEntryOptions(options)
  const path = getNavigateEntryPath(parsedOptions)
  const { backPath } = options || {}
  const route = getReadonlyRoute()
  const currentPath = route.location.pathname + route.location.search
  if (path === currentPath) return

  if (backPath) {
    setPreviewBackPath(backPath)
  }

  tracker.navigateEntry({
    feedId: parsedOptions.feedId,
    entryId: parsedOptions.entryId,
    timelineId: parsedOptions.timelineId,
  })

  disableShowAISummaryOnce()
  const sourceContent = getEntry(parsedOptions.entryId)?.settings?.sourceContent
  if (!sourceContent) {
    resetShowSourceContent()
  }

  const navigate = getStableRouterNavigate()

  if (!navigate) {
    const message =
      "Navigation is not available, maybe a mistake in the code, please report an issue. thx."
    toast.error(message)
    throw new Error(message, { cause: "Navigation is not available" })
  }

  return navigate?.(path)
}

export const useBackHome = (timelineId?: string) => {
  const navigate = useNavigateEntry()
  const feedId = useRouteParamsSelector((state) => state.feedId)
  const entryId = useRouteParamsSelector((state) => state.entryId)
  const currentView = useRouteParamsSelector((state) => state.view)
  const backToFeed =
    entryId && feedId && entryId !== ROUTE_ENTRY_PENDING && feedId !== ROUTE_FEED_PENDING
  const feedIdToNavigate = backToFeed ? feedId : null

  return useCallback(
    (overvideTimelineId?: string) => {
      navigate({
        feedId: feedIdToNavigate,
        entryId: null,
        timelineId: overvideTimelineId ?? timelineId,
        view: currentView,
      })
    },
    [navigate, feedIdToNavigate, timelineId, currentView],
  )
}
