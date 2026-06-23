import { Spring } from "@follow/components/constants/spring.js"
import { MotionButtonBase } from "@follow/components/ui/button/index.js"
import { Checkbox } from "@follow/components/ui/checkbox/index.js"
import { RSSHubLogo } from "@follow/components/ui/platform-icon/icons.js"
import { useScrollViewElement } from "@follow/components/ui/scroll-area/hooks.js"
import { ResponsiveSelect } from "@follow/components/ui/select/responsive.js"
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipTrigger,
} from "@follow/components/ui/tooltip/index.js"
import { EllipsisHorizontalTextWithTooltip } from "@follow/components/ui/typography/index.js"
import { getFeedById } from "@follow/store/feed/getter"
import { useFeedById } from "@follow/store/feed/hooks"
import { getSubscriptionByFeedId } from "@follow/store/subscription/getter"
import {
  useAllFeedSubscriptionIds,
  useSubscriptionByFeedId,
} from "@follow/store/subscription/hooks"
import { clsx, sortByAlphabet } from "@follow/utils/utils"
import { useVirtualizer } from "@tanstack/react-virtual"
import { AnimatePresence, m } from "motion/react"
import type { FC, MouseEvent } from "react"
import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { RelativeDay } from "~/components/ui/datetime"
import { copyToClipboard } from "~/lib/clipboard"
import { FeedIcon } from "~/modules/feed/feed-icon"
import { useConfirmUnsubscribeSubscriptionModal } from "~/modules/modal/hooks/useConfirmUnsubscribeSubscriptionModal"
import { SettingModalContentPortal } from "~/modules/settings/modal/layout"

type SortField = "name" | "date"
type SortDirection = "asc" | "desc"
type FeedFilter = "all" | "rsshub"

export const SettingFeeds = () => (
  <div className="space-y-4 pb-8">
    <SubscriptionFeedsSection />
  </div>
)

const GRID_COLS_CLASSNAME = "grid-cols-[30px_minmax(180px,1.2fr)_minmax(220px,1fr)_150px]"

const SubscriptionFeedsSection = () => {
  const { t } = useTranslation("settings")
  const allFeeds = useAllFeedSubscriptionIds()
  const [selectedFeeds, setSelectedFeeds] = useState<Set<string>>(() => new Set())
  const [sortField, setSortField] = useState<SortField>("name")
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc")
  const [filter, setFilter] = useState<FeedFilter>("all")

  // Calculate RSSHub feeds count
  const rsshubFeedsCount = useMemo(() => {
    return allFeeds.filter((feedId) => {
      const feed = getFeedById(feedId)
      return Boolean(feed?.url?.startsWith("rsshub://"))
    }).length
  }, [allFeeds])

  // Filter feeds based on selected filter
  const filteredFeeds = useMemo(() => {
    if (filter === "all") {
      return allFeeds
    }
    return allFeeds.filter((feedId) => {
      const feed = getFeedById(feedId)
      return Boolean(feed?.url?.startsWith("rsshub://"))
    })
  }, [allFeeds, filter])

  // Clean up selectedFeeds when filter changes
  const filteredFeedsSet = useMemo(() => new Set(filteredFeeds), [filteredFeeds])

  // Clean selected feeds that are not in current filter
  useEffect(() => {
    setSelectedFeeds((prev) => {
      const cleaned = new Set<string>()
      prev.forEach((feedId) => {
        if (filteredFeedsSet.has(feedId)) {
          cleaned.add(feedId)
        }
      })
      return cleaned
    })
  }, [filteredFeedsSet])

  const handleSort = useCallback(
    (field: SortField) => {
      if (sortField === field) {
        setSortDirection(sortDirection === "asc" ? "desc" : "asc")
      } else {
        setSortField(field)
        setSortDirection("asc")
      }
    },
    [sortField, sortDirection],
  )

  const handleSelectAll = useCallback(
    (checked: boolean) => {
      if (checked) {
        setSelectedFeeds(new Set(filteredFeeds))
      } else {
        setSelectedFeeds(new Set())
      }
    },
    [filteredFeeds],
  )

  const handleSelectFeed = useCallback((feedId: string, checked: boolean) => {
    setSelectedFeeds((prev) => {
      const newSet = new Set(prev)
      if (checked) {
        newSet.add(feedId)
      } else {
        newSet.delete(feedId)
      }
      return newSet
    })
  }, [])

  const isAllSelected = filteredFeeds.length > 0 && selectedFeeds.size === filteredFeeds.length

  const presentDeleteSubscription = useConfirmUnsubscribeSubscriptionModal()
  const handleBatchUnsubscribe = useCallback(() => {
    const feedIds = Array.from(selectedFeeds)
    presentDeleteSubscription(feedIds, () => setSelectedFeeds(new Set()))
  }, [presentDeleteSubscription, selectedFeeds, setSelectedFeeds])

  return (
    <section className="relative mt-4">
      <div className="mb-2 flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">{t("feeds.subscription")}</h2>
        {allFeeds.length > 0 && (
          <ResponsiveSelect
            size="sm"
            triggerClassName="w-36"
            value={filter}
            onValueChange={(value) => setFilter(value as FeedFilter)}
            items={[
              {
                label: t("feeds.filter.all", { count: allFeeds.length }),
                value: "all",
              },
              {
                label: t("feeds.filter.rsshub", { count: rsshubFeedsCount }),
                value: "rsshub",
              },
            ]}
          />
        )}
      </div>

      {filteredFeeds.length > 0 && (
        <div className="mt-6 space-y-0.5">
          {/* Header - Sticky */}
          <div
            className={clsx(
              "sticky top-0 z-20 grid h-7 gap-3 border-b border-border bg-background/80 px-1 pb-1.5 text-xs font-medium text-text-secondary backdrop-blur-sm",
              GRID_COLS_CLASSNAME,
            )}
          >
            <div className="flex items-center justify-center">
              <Checkbox size="sm" checked={isAllSelected} onCheckedChange={handleSelectAll} />
            </div>
            <button
              type="button"
              className="text-left transition-colors hover:text-text"
              onClick={() => handleSort("name")}
            >
              {t("feeds.tableHeaders.name")}
              {sortField === "name" && (
                <span className="ml-1">{sortDirection === "asc" ? "↑" : "↓"}</span>
              )}
            </button>
            <div className="min-w-0 text-left">{t("feeds.tableHeaders.url")}</div>
            <button
              className="text-center transition-colors hover:text-text"
              onClick={() => handleSort("date")}
              type="button"
            >
              {t("feeds.tableHeaders.date")}
              {sortField === "date" && (
                <span className="ml-1">{sortDirection === "asc" ? "↑" : "↓"}</span>
              )}
            </button>
          </div>

          {/* Feed List */}
          <div className="relative">
            <SortedFeedsList
              feeds={filteredFeeds}
              sortField={sortField}
              sortDirection={sortDirection}
              selectedFeeds={selectedFeeds}
              onSelect={handleSelectFeed}
            />
          </div>
        </div>
      )}

      {/* Sticky Action Bar at bottom when scrolled */}
      <AnimatePresence>
        {selectedFeeds.size > 0 && (
          <SettingModalContentPortal>
            <m.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              transition={Spring.presets.smooth}
              className="absolute inset-x-0 bottom-3 z-10 flex justify-center px-3"
            >
              <div
                className="relative overflow-hidden rounded-2xl backdrop-blur-2xl"
                style={{
                  backgroundImage:
                    "linear-gradient(to bottom right, rgba(var(--color-background) / 0.98), rgba(var(--color-background) / 0.95))",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "hsl(var(--fo-a) / 0.2)",
                  boxShadow:
                    "0 8px 32px hsl(var(--fo-a) / 0.08), 0 4px 16px hsl(var(--fo-a) / 0.06), 0 2px 8px rgba(0, 0, 0, 0.1)",
                }}
              >
                {/* Inner glow layer */}
                <div
                  className="absolute inset-0 rounded-2xl"
                  style={{
                    background:
                      "linear-gradient(to bottom right, hsl(var(--fo-a) / 0.05), transparent, hsl(var(--fo-a) / 0.05))",
                  }}
                />

                {/* Content */}
                <div className="relative flex items-center justify-between gap-4 px-5 py-3">
                  <span className="text-sm text-text-secondary">
                    {t("feeds.tableSelected.item", { count: selectedFeeds.size })}
                  </span>

                  <div className="flex items-center gap-3">
                    <button
                      className="cursor-button text-xs text-accent transition-colors hover:text-accent/80"
                      type="button"
                      onClick={() => setSelectedFeeds(new Set())}
                    >
                      {t("feeds.tableSelected.clear")}
                    </button>

                    <div
                      className="h-4 w-px"
                      style={{
                        background:
                          "linear-gradient(to bottom, transparent, hsl(var(--fo-a) / 0.2), transparent)",
                      }}
                    />

                    <MotionButtonBase
                      data-testid="feeds-batch-unsubscribe"
                      className="text-xs text-red transition-colors hover:text-red/80"
                      type="button"
                      onClick={handleBatchUnsubscribe}
                    >
                      {t("feeds.tableSelected.unsubscribe")}
                    </MotionButtonBase>
                  </div>
                </div>
              </div>
            </m.div>
          </SettingModalContentPortal>
        )}
      </AnimatePresence>
    </section>
  )
}

const SortedFeedsList: FC<{
  feeds: string[]
  sortField: SortField
  sortDirection: SortDirection
  selectedFeeds: Set<string>
  onSelect: (feedId: string, checked: boolean) => void
}> = ({ feeds, sortField, sortDirection, selectedFeeds, onSelect }) => {
  const scrollContainerElement = useScrollViewElement()

  const sortedFeedIds = useMemo(() => {
    switch (sortField) {
      case "date": {
        return feeds.sort((a, b) => {
          const aSubscription = getSubscriptionByFeedId(a)
          const bSubscription = getSubscriptionByFeedId(b)
          if (!aSubscription || !bSubscription) return 0
          if (!aSubscription.createdAt || !bSubscription.createdAt) return 0
          const aDate = new Date(aSubscription.createdAt)
          const bDate = new Date(bSubscription.createdAt)
          return sortDirection === "asc"
            ? aDate.getTime() - bDate.getTime()
            : bDate.getTime() - aDate.getTime()
        })
      }
      case "name": {
        return feeds.sort((a, b) => {
          const aSubscription = getSubscriptionByFeedId(a)
          const bSubscription = getSubscriptionByFeedId(b)
          if (!aSubscription || !bSubscription) return 0
          const aFeed = getFeedById(a)
          const bFeed = getFeedById(b)
          if (!aFeed || !bFeed) return 0
          const aCompareTitle = aSubscription.title || aFeed.title || ""
          const bCompareTitle = bSubscription.title || bFeed.title || ""
          return sortDirection === "asc"
            ? sortByAlphabet(aCompareTitle, bCompareTitle)
            : sortByAlphabet(bCompareTitle, aCompareTitle)
        })
      }
    }
  }, [feeds, sortDirection, sortField])

  const rowVirtualizer = useVirtualizer({
    count: sortedFeedIds.length,
    getScrollElement: () => scrollContainerElement,
    estimateSize: () => 38, // Estimated height of each feed item (h-9 = 36px + 2px gap)
    overscan: 5,
  })

  const virtualItems = rowVirtualizer.getVirtualItems()

  return (
    <div
      className="space-y-0.5"
      style={{
        height: `${rowVirtualizer.getTotalSize()}px`,
        width: "100%",
        position: "relative",
      }}
    >
      {virtualItems.map((virtualRow) => {
        const feedId = sortedFeedIds[virtualRow.index]
        if (!feedId) return null

        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={rowVirtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <FeedListItem id={feedId} selected={selectedFeeds.has(feedId)} onSelect={onSelect} />
          </div>
        )
      })}
    </div>
  )
}

const FeedListItem = memo(
  ({
    id,
    selected,
    onSelect,
  }: {
    id: string
    selected: boolean
    onSelect: (feedId: string, checked: boolean) => void
  }) => {
    const subscription = useSubscriptionByFeedId(id)
    const feed = useFeedById(id)
    const { t } = useTranslation("settings")
    const { t: commonT } = useTranslation("common")
    const isCustomizeName = subscription?.title && feed?.title !== subscription?.title
    const isRSSHub = Boolean(feed?.url?.startsWith("rsshub://"))
    const feedUrl = feed?.url

    const handleCopyFeedUrl = useCallback(
      (event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation()
        if (!feedUrl) return

        copyToClipboard(feedUrl)
        toast.success(commonT("app.copied_to_clipboard"))
      },
      [commonT, feedUrl],
    )

    if (!subscription) return null

    return (
      <div
        data-id={id}
        data-testid={`settings-feed-row-${id}`}
        role="button"
        tabIndex={-1}
        className={clsx(
          "group relative grid h-9 w-full items-center gap-3 rounded-md px-1.5 transition-all",
          "content-visibility-auto contain-intrinsic-size-[auto_2.25rem]",
          GRID_COLS_CLASSNAME,
          "hover:bg-material-medium",

          selected && "bg-material-thick",
        )}
        onClick={() => onSelect(id, !selected)}
      >
        <div className="flex items-center justify-center">
          <Checkbox
            size="sm"
            checked={selected}
            onCheckedChange={(checked) => onSelect(id, !!checked)}
          />
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <FeedIcon target={feed} size={14} />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-1">
              {feed?.errorAt ? (
                <Tooltip>
                  <TooltipTrigger>
                    <EllipsisHorizontalTextWithTooltip className="text-sm font-medium leading-tight text-red">
                      {subscription.title || feed?.title}
                    </EllipsisHorizontalTextWithTooltip>
                  </TooltipTrigger>
                  <TooltipPortal>
                    <TooltipContent>
                      {feed?.errorMessage || "Feed has encountered an error"}
                    </TooltipContent>
                  </TooltipPortal>
                </Tooltip>
              ) : (
                <EllipsisHorizontalTextWithTooltip className="text-sm font-medium leading-tight text-text">
                  {subscription.title || feed?.title}
                </EllipsisHorizontalTextWithTooltip>
              )}
              {isRSSHub && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="inline-flex shrink-0 items-center gap-0.5 rounded bg-orange/20 px-1 py-0.5 text-[9px] font-semibold text-orange shadow-sm ring-1 ring-orange/30">
                      <RSSHubLogo className="size-2.5" />
                      <span>RSSHub</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipPortal>
                    <TooltipContent>{t("feeds.tooltips.rsshub_powered")}</TooltipContent>
                  </TooltipPortal>
                </Tooltip>
              )}
            </div>
            {isCustomizeName && (
              <EllipsisHorizontalTextWithTooltip className="text-left text-xs leading-tight text-text-secondary">
                {feed?.title}
              </EllipsisHorizontalTextWithTooltip>
            )}
          </div>
        </div>
        <div className="group/url flex min-w-0 items-center gap-1.5 text-xs text-text-secondary">
          {feedUrl ? (
            <>
              <span className="min-w-0 flex-1 truncate" title={feedUrl}>
                {feedUrl}
              </span>
              <button
                type="button"
                className="flex size-6 shrink-0 cursor-button items-center justify-center rounded text-text-tertiary opacity-0 transition-colors hover:bg-fill-secondary hover:text-text group-hover/url:opacity-100"
                aria-label={commonT("words.copy")}
                title={commonT("words.copy")}
                onClick={handleCopyFeedUrl}
              >
                <i className="i-focal-copy-2 size-3.5" />
              </button>
            </>
          ) : (
            <span className="text-[11px] text-text-secondary">--</span>
          )}
        </div>
        {!!subscription.createdAt && (
          <div className="whitespace-nowrap pr-1 text-center text-xs">
            <RelativeDay date={new Date(subscription.createdAt)} />
          </div>
        )}
      </div>
    )
  },
)
