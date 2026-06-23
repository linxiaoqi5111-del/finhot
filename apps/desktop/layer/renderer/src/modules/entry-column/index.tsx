import { FeedViewType, getView } from "@follow/constants"
import { useScrollMarkReadGracePeriod, useTitle } from "@follow/hooks"
import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { getScrollMarkReadRangeState } from "@follow/shared/scroll-mark-read"
import { useEntry } from "@follow/store/entry/hooks"
import { useFeedById } from "@follow/store/feed/hooks"
import { useSubscriptionByFeedId } from "@follow/store/subscription/hooks"
import { unreadSyncService } from "@follow/store/unread/store"
import { useIsLoggedIn, useWhoami } from "@follow/store/user/hooks"
import { isBizId } from "@follow/utils/utils"
import type { Range, Virtualizer } from "@tanstack/react-virtual"
import { atom, useAtomValue, useSetAtom } from "jotai"
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { useGeneralSettingKey } from "~/atoms/settings/general"
import { Focusable } from "~/components/common/Focusable"
import { FeedNotFound } from "~/components/errors/FeedNotFound"
import { FEED_COLLECTION_LIST, HotkeyScope, ROUTE_FEED_PENDING } from "~/constants"
import { useNavigateEntry } from "~/hooks/biz/useNavigateEntry"
import { useRouteParams, useRouteParamsSelector } from "~/hooks/biz/useRouteParams"
import { isVirtualTimelineScopeFeedId, SMART_FEED_RADAR } from "~/lib/timeline-scope"
import { RadarPanel } from "~/modules/hot-radar/RadarPanel"
import { useFeedQuery, useRefreshFeedMutation } from "~/queries/feed"
import { useFeedHeaderTitle } from "~/store/feed/hooks"

import { aiTimelineEnabledAtom } from "./atoms/ai-timeline"
import { timelineRefreshingAtom } from "./atoms/timeline-refreshing"
import { AITimelineLoadingOverlay } from "./components/ai-timeline-loading/AITimelineLoadingOverlay"
import { EntryColumnWrapper } from "./components/entry-column-wrapper/EntryColumnWrapper"
import { FooterMarkItem } from "./components/FooterMarkItem"
import { PlatformFilterTabs } from "./components/PlatformFilterTabs"
import { useEntriesActions, useEntriesState } from "./context/EntriesContext"
import { EntryItemSkeleton } from "./EntryItemSkeleton"
import { EntryColumnGrid } from "./grid"
import { useAttachScrollBeyond } from "./hooks/useAttachScrollBeyond"
import { useSnapEntryIdList } from "./hooks/useEntryIdListSnap"
import { useEntryMarkReadHandler } from "./hooks/useEntryMarkReadHandler"
import { useNavigateFirstEntry } from "./hooks/useNavigateFirstEntry"
import { EntryListHeader } from "./layouts/EntryListHeader"
import { EntryEmptyList, EntryList } from "./list"
import { shouldScrollTimelineToTopOnRefreshStateChange } from "./refresh-reset"
import { shouldSuspendMarkReadForScrollReset } from "./scroll-reset"
import { EntryRootStateContext } from "./store/EntryColumnContext"

function EntryColumnContent() {
  const listRef = useRef<Virtualizer<HTMLElement, Element>>(undefined)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const { t } = useTranslation()
  const state = useEntriesState()

  const isInteracted = useRef(false)
  const scrollMarkReadAnchorIndexRef = useRef<number | null>(null)
  const latestRangeStartIndexRef = useRef<number | null>(null)
  const resetScrollInteractionState = useCallback(() => {
    isInteracted.current = false
    scrollMarkReadAnchorIndexRef.current = null
    latestRangeStartIndexRef.current = null
  }, [])

  const actions = useEntriesActions()
  const [resetScrollSignal, setResetScrollSignal] = useState<number>()
  const [appliedResetScrollSignal, setAppliedResetScrollSignal] = useState<number>()
  const isScrollResetPending = shouldSuspendMarkReadForScrollReset({
    resetSignal: resetScrollSignal,
    appliedResetSignal: appliedResetScrollSignal,
  })
  const handleResetScrollSignalConsumed = useCallback((signal: number) => {
    setAppliedResetScrollSignal((currentSignal) =>
      currentSignal === signal ? currentSignal : signal,
    )
  }, [])
  const scrollTimelineToTop = useCallback(() => {
    resetScrollInteractionState()
    setResetScrollSignal((signal) => (signal ?? 0) + 1)

    const runScrollToTop = () => {
      listRef.current?.scrollToOffset(0)

      const scrollArea = scrollAreaRef.current
      if (!scrollArea) return

      scrollArea.scrollTop = 0
      scrollArea.scrollLeft = 0
    }

    runScrollToTop()
    globalThis.requestAnimationFrame?.(runScrollToTop)
  }, [resetScrollInteractionState])
  // Register reset handler to keep scroll behavior when data resets
  useEffect(() => {
    actions.setOnReset(scrollTimelineToTop)
    return () => actions.setOnReset(null)
  }, [actions, scrollTimelineToTop])

  const { entriesIds: rawEntriesIds, groupedCounts: rawGroupedCounts } = state

  const {
    entryId: activeEntryId,
    view,
    feedId: routeFeedId,
    isPendingEntry,
    isCollection,
  } = useRouteParams()

  const entriesIds = rawEntriesIds
  const groupedCounts = rawGroupedCounts

  useSnapEntryIdList(entriesIds)

  const entry = useEntry(activeEntryId, (state) => {
    const { feedId } = state
    return { feedId }
  })
  const feed = useFeedById(routeFeedId)
  const title = useFeedHeaderTitle()
  useTitle(title)
  const isLoggedIn = useIsLoggedIn()
  const user = useWhoami()
  const timelineIdentity = `${view}:${routeFeedId ?? ""}`
  const { mutateAsync: refreshFeed, isPending: isFeedRefreshPending } =
    useRefreshFeedMutation(routeFeedId)

  useEffect(() => {
    if (!activeEntryId) return

    if (isPendingEntry) return
    if (!entry?.feedId) return

    if (!isLoggedIn) return
    unreadSyncService.markEntryAsRead(activeEntryId)
  }, [activeEntryId, entry?.feedId, isPendingEntry, isLoggedIn])

  const isTimelineFetching = state.isFetching && !state.isFetchingNextPage
  const isRefreshing = isTimelineFetching || isFeedRefreshPending
  const pauseScrollMarkRead = useScrollMarkReadGracePeriod(
    isRefreshing,
    undefined,
    timelineIdentity,
  )

  useLayoutEffect(() => {
    resetScrollInteractionState()
  }, [resetScrollInteractionState, timelineIdentity])

  const handleManualRefresh = useCallback(() => {
    scrollTimelineToTop()

    if (
      !LOCAL_RSS_MODE &&
      routeFeedId &&
      feed?.ownerUserId === user?.id &&
      isBizId(routeFeedId) &&
      feed?.type === "feed"
    ) {
      void refreshFeed()
      return
    }

    actions.refetch()
  }, [
    actions,
    feed?.ownerUserId,
    feed?.type,
    refreshFeed,
    routeFeedId,
    scrollTimelineToTop,
    user?.id,
  ])

  const wasRefreshingRef = useRef(isRefreshing)
  const setTimelineRefreshing = useSetAtom(timelineRefreshingAtom)
  useEffect(() => {
    setTimelineRefreshing(isRefreshing)
    return () => {
      setTimelineRefreshing(false)
    }
  }, [isRefreshing, setTimelineRefreshing])

  useEffect(() => {
    const wasRefreshing = wasRefreshingRef.current
    wasRefreshingRef.current = isRefreshing

    if (
      !shouldScrollTimelineToTopOnRefreshStateChange({
        wasRefreshing,
        isRefreshing,
      })
    ) {
      return
    }
    scrollTimelineToTop()
  }, [isRefreshing, scrollTimelineToTop])

  const { handleRenderMarkRead, handleScrollMarkRead } = useEntryMarkReadHandler(entriesIds, {
    pauseScrollMarkRead,
  })

  const flushScrollMarkRead = useCallback(
    (currentStartIndex: number) => {
      if (!routeFeedId) return

      const { nextAnchorIndex, range } = getScrollMarkReadRangeState({
        anchorIndex: scrollMarkReadAnchorIndexRef.current,
        currentStartIndex,
      })
      scrollMarkReadAnchorIndexRef.current = nextAnchorIndex

      if (range) {
        handleScrollMarkRead?.(range as Range, isInteracted.current)
      }
    },
    [handleScrollMarkRead, routeFeedId],
  )

  const handleScroll = useCallback(() => {
    if (isScrollResetPending) {
      return
    }

    if (!isInteracted.current) {
      isInteracted.current = true
    }

    if (latestRangeStartIndexRef.current !== null) {
      flushScrollMarkRead(latestRangeStartIndexRef.current)
    }
  }, [flushScrollMarkRead, isScrollResetPending])

  const { handleScroll: handleScrollBeyond } = useAttachScrollBeyond()
  const handleCombinedScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      handleScrollBeyond(e)
      handleScroll()
    },
    [handleScrollBeyond, handleScroll],
  )

  const navigate = useNavigateEntry()

  const aiTimelineEnabled = useAtomValue(aiTimelineEnabledAtom)
  const showAiTimelineLoading = aiTimelineEnabled && state.isLoading && !state.isFetchingNextPage
  const renderAsRead = useGeneralSettingKey("renderMarkUnread")
  const handleRangeChange = useCallback(
    (e: Range) => {
      if (latestRangeStartIndexRef.current === e.startIndex) {
        return
      }

      latestRangeStartIndexRef.current = e.startIndex
      if (isScrollResetPending) {
        return
      }

      if (scrollMarkReadAnchorIndexRef.current === null) {
        scrollMarkReadAnchorIndexRef.current = e.startIndex
      } else if (isInteracted.current) {
        flushScrollMarkRead(e.startIndex)
      }

      if (!renderAsRead) return
      if (!getView(view)?.wideMode) {
        return
      }
      // For gird, render as mark read logic
      handleRenderMarkRead?.(e, isInteracted.current)
    },
    [flushScrollMarkRead, handleRenderMarkRead, isScrollResetPending, renderAsRead, view],
  )

  const fetchNextPage = useCallback(() => {
    if (state.hasNextPage && !state.isFetchingNextPage) {
      actions.fetchNextPage()
    }
  }, [actions, state.hasNextPage, state.isFetchingNextPage])

  const ListComponent = getView(view)?.gridMode ? EntryColumnGrid : EntryList

  useNavigateFirstEntry(entriesIds, activeEntryId, view, navigate)

  return (
    <Focusable
      scope={HotkeyScope.Timeline}
      data-hide-in-print
      className="relative flex h-full flex-1 flex-col @container"
      onClick={() =>
        navigate({
          view,
          entryId: null,
        })
      }
    >
      {entriesIds.length === 0 &&
        !state.isLoading &&
        !state.error &&
        (!feed || feed?.type === "feed") && <AddFeedHelper />}

      <EntryListHeader />
      <PlatformFilterTabs />

      <EntryColumnWrapper
        ref={scrollAreaRef}
        onScroll={handleCombinedScroll}
        key={`${routeFeedId}-${view}`}
      >
        {entriesIds.length === 0 ? (
          state.isLoading ? (
            <EntryItemSkeleton view={view} />
          ) : (
            <EntryEmptyList />
          )
        ) : (
          <ListComponent
            gap={view === FeedViewType.SocialMedia ? 10 : undefined}
            listRef={listRef}
            onRangeChange={handleRangeChange}
            hasNextPage={state.hasNextPage}
            view={view}
            feedId={routeFeedId || ""}
            entriesIds={entriesIds}
            fetchNextPage={fetchNextPage}
            refetch={handleManualRefresh}
            groupCounts={groupedCounts}
            appliedResetScrollSignal={appliedResetScrollSignal}
            onResetScrollSignalConsumed={handleResetScrollSignalConsumed}
            resetScrollSignal={resetScrollSignal}
            suspendMarkRead={isScrollResetPending}
            syncType={state.type}
            Footer={
              isCollection ? void 0 : <FooterMarkItem view={view} fetchedTime={state.fetchedTime} />
            }
          />
        )}
      </EntryColumnWrapper>

      <AITimelineLoadingOverlay
        visible={showAiTimelineLoading}
        label={t("entry_list_header.ai_timeline_loading")}
      />
    </Focusable>
  )
}

function EntryColumnImpl() {
  const feedId = useRouteParamsSelector((s) => s.feedId)
  const contextValue = useMemo(
    () => ({
      isScrolledBeyondThreshold: atom(false),
    }),
    [],
  )

  if (feedId === SMART_FEED_RADAR) {
    return <RadarPanel />
  }

  return (
    <EntryRootStateContext value={contextValue}>
      <EntryColumnContent />
    </EntryRootStateContext>
  )
}

const AddFeedHelper = () => {
  const feedId = useRouteParamsSelector((s) => s.feedId)
  const isVirtualScope = isVirtualTimelineScopeFeedId(feedId)
  const feedQuery = useFeedQuery({ id: isVirtualScope ? undefined : feedId })

  const hasSubscription = useSubscriptionByFeedId(feedId || "")

  if (hasSubscription) {
    return null
  }

  if (!feedId) {
    return
  }
  if (feedId === FEED_COLLECTION_LIST || feedId === ROUTE_FEED_PENDING) {
    return null
  }
  if (isVirtualScope) {
    return null
  }
  if (!isBizId(feedId)) {
    return null
  }

  if (feedQuery.error && feedQuery.error.statusCode === 404) {
    throw new FeedNotFound()
  }
}

export const EntryColumn = memo(EntryColumnImpl)
