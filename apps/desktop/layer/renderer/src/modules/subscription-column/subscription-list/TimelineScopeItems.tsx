import { useAllCollectionEntryList } from "@follow/store/collection/hooks"
import { useEntryStore } from "@follow/store/entry/store"
import { useUnreadAll } from "@follow/store/unread/hooks"
import { cn } from "@follow/utils"
import { getStorageNS } from "@follow/utils/ns"
import { useAtom } from "jotai"
import { atomWithStorage } from "jotai/utils"
import type { ReactNode } from "react"
import { memo, useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { FEED_COLLECTION_LIST, ROUTE_VIEW_ALL } from "~/constants"
import { useNavigateEntry } from "~/hooks/biz/useNavigateEntry"
import { useRouteParamsSelector } from "~/hooks/biz/useRouteParams"
import { SMART_FEED_RADAR, SMART_FEED_TODAY, SMART_FEED_UNREAD } from "~/lib/timeline-scope"

import { feedColumnStyles } from "../styles"
import { UnreadNumber } from "../UnreadNumber"
import { CollapsibleSectionHeader } from "./CollapsibleSectionHeader"

const smartFeedsCollapsedAtom = atomWithStorage(
  getStorageNS("timeline-smart-feeds-collapsed"),
  false,
)

const DAY_START_HOUR = 6
const NIGHT_START_HOUR = 18

const getTodaySmartFeedIcon = (date = new Date()) => {
  const hour = date.getHours()
  return hour >= DAY_START_HOUR && hour < NIGHT_START_HOUR ? "i-lucide-sun" : "i-lucide-sun-moon"
}

const getNextTodaySmartFeedIconUpdateDelay = (date = new Date()) => {
  const nextUpdate = new Date(date)
  const hour = date.getHours()

  if (hour < DAY_START_HOUR) {
    nextUpdate.setHours(DAY_START_HOUR, 0, 0, 0)
  } else if (hour < NIGHT_START_HOUR) {
    nextUpdate.setHours(NIGHT_START_HOUR, 0, 0, 0)
  } else {
    nextUpdate.setDate(nextUpdate.getDate() + 1)
    nextUpdate.setHours(DAY_START_HOUR, 0, 0, 0)
  }

  return Math.max(0, nextUpdate.getTime() - date.getTime())
}

const useTodaySmartFeedIcon = () => {
  const [icon, setIcon] = useState(() => getTodaySmartFeedIcon())

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const scheduleNextUpdate = () => {
      const now = new Date()
      setIcon(getTodaySmartFeedIcon(now))
      timer = setTimeout(scheduleNextUpdate, getNextTodaySmartFeedIconUpdateDelay(now))
    }

    scheduleNextUpdate()

    return () => {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [])

  return icon
}

const isSameLocalDay = (date: Date, offset: number) => {
  const target = new Date()
  target.setDate(target.getDate() + offset)

  return (
    date.getFullYear() === target.getFullYear() &&
    date.getMonth() === target.getMonth() &&
    date.getDate() === target.getDate()
  )
}

const ScopeItem = ({
  actions,
  feedId,
  icon,
  iconClassName,
  isActive,
  onBeforeNavigate,
  title,
  unread,
}: {
  actions?: ReactNode
  feedId: string
  icon: string
  iconClassName?: string
  isActive?: boolean
  onBeforeNavigate?: () => void
  title: string
  unread?: number
}) => {
  const activeFeedId = useRouteParamsSelector((params) => params.feedId)
  const navigateEntry = useNavigateEntry()
  const hasTrailing = !!actions || !!unread

  return (
    <div
      data-sub={`scope-${feedId}`}
      data-active={isActive ?? activeFeedId === feedId}
      className={cn("group/scope mt-1 flex h-8 shrink-0 gap-2 px-2.5", feedColumnStyles.item)}
      onClick={(event) => {
        event.stopPropagation()
        onBeforeNavigate?.()
        navigateEntry({
          timelineId: ROUTE_VIEW_ALL,
          feedId,
          entryId: null,
        })
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <i className={cn(icon, "size-4 shrink-0", iconClassName)} />
        <span className="truncate">{title}</span>
      </div>
      {hasTrailing && (
        <div className="ml-2 flex shrink-0 items-center justify-end">
          <UnreadNumber unread={unread} />
          {actions}
        </div>
      )}
    </div>
  )
}

const useSmartFeedUnreadCounts = () => {
  const allUnread = useUnreadAll()
  const collectionEntryIds = useAllCollectionEntryList()

  const starredUnreadCount = useEntryStore(
    useCallback(
      (state) => {
        let starred = 0

        for (const entryId of collectionEntryIds) {
          const entry = state.data[entryId]
          if (!entry || entry.read) continue
          starred += 1
        }

        return starred
      },
      [collectionEntryIds],
    ),
  )

  const todayUnreadCount = useEntryStore((state) => {
    let today = 0

    for (const entry of Object.values(state.data)) {
      if (!entry || entry.read) continue

      if (isSameLocalDay(entry.publishedAt, 0)) {
        today += 1
      }
    }

    return today
  })

  return {
    today: todayUnreadCount,
    starred: starredUnreadCount,
    unread: allUnread,
  }
}

export const TimelineScopeItems = memo(() => {
  const { t } = useTranslation()
  const counts = useSmartFeedUnreadCounts()
  const todayIcon = useTodaySmartFeedIcon()
  const activeFeedId = useRouteParamsSelector((params) => params.feedId)
  const [smartFeedsCollapsed, setSmartFeedsCollapsed] = useAtom(smartFeedsCollapsedAtom)
  const smartFeedsOpen = !smartFeedsCollapsed
  const toggleSmartFeeds = useCallback(() => {
    setSmartFeedsCollapsed((current) => !current)
  }, [setSmartFeedsCollapsed])
  return (
    <>
      <CollapsibleSectionHeader
        className="mt-0"
        isOpen={smartFeedsOpen}
        onToggle={toggleSmartFeeds}
      >
        {t("sidebar.smart_feeds.title")}
      </CollapsibleSectionHeader>
      {smartFeedsOpen && (
        <>
          <ScopeItem
            feedId={SMART_FEED_TODAY}
            icon={todayIcon}
            iconClassName="text-orange"
            title={t("time.today", { ns: "common" })}
            unread={counts.today}
          />
          <ScopeItem
            feedId={SMART_FEED_UNREAD}
            icon="i-lucide-scroll-text"
            iconClassName="text-blue"
            title={t("sidebar.smart_feeds.all_unread")}
            unread={counts.unread}
          />
          <ScopeItem
            feedId={FEED_COLLECTION_LIST}
            icon="i-focal-star-fill"
            iconClassName="text-orange-500"
            isActive={activeFeedId === FEED_COLLECTION_LIST}
            title={t("words.starred")}
            unread={counts.starred}
          />
          <ScopeItem
            feedId={SMART_FEED_RADAR}
            icon="i-lucide-radar"
            iconClassName="text-purple"
            title="热点雷达"
          />
        </>
      )}
    </>
  )
})

TimelineScopeItems.displayName = "TimelineScopeItems"
