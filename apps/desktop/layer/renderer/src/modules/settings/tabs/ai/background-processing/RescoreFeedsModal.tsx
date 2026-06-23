import { Button } from "@follow/components/ui/button/index.js"
import { Checkbox } from "@follow/components/ui/checkbox/index.jsx"
import { ScrollArea } from "@follow/components/ui/scroll-area/ScrollArea.js"
import { getViewList } from "@follow/constants"
import { entryEnrichmentService } from "@follow/store/enrichment/service"
import { listRescoreEligibleEntryIdsByFeedIds } from "@follow/store/entry-quality-score/backlog"
import { getFeedById } from "@follow/store/feed/getter"
import { useSubscriptionStore } from "@follow/store/subscription/store"
import { cn } from "@follow/utils/utils"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { getActionLanguage } from "~/atoms/settings/general"
import { FeedIcon } from "~/modules/feed/feed-icon"

const useFeedSubscriptionOptions = () => {
  return useSubscriptionStore((state) => {
    const feedIds = new Set<string>()

    for (const view of getViewList()) {
      for (const id of state.feedIdByView[view.view] ?? []) {
        if (getFeedById(id)) {
          feedIds.add(id)
        }
      }
    }

    return Array.from(feedIds)
      .map((feedId) => {
        const feed = getFeedById(feedId)
        return {
          feedId,
          title: feed?.title?.trim() || feedId,
        }
      })
      .sort((left, right) =>
        left.title.localeCompare(right.title, undefined, { sensitivity: "base" }),
      )
  })
}

export const RescoreFeedsModalContent = ({ onSuccess }: { onSuccess: () => void }) => {
  const { t } = useTranslation("ai")
  const feedOptions = useFeedSubscriptionOptions()
  const [selectedFeedIds, setSelectedFeedIds] = useState<Set<string>>(new Set())
  const [isSubmitting, setIsSubmitting] = useState(false)

  const eligibleEntryCount = useMemo(
    () => listRescoreEligibleEntryIdsByFeedIds(Array.from(selectedFeedIds)).length,
    [selectedFeedIds],
  )

  const allSelected = feedOptions.length > 0 && selectedFeedIds.size === feedOptions.length

  const toggleFeed = (feedId: string, checked: boolean) => {
    setSelectedFeedIds((current) => {
      const next = new Set(current)
      if (checked) {
        next.add(feedId)
      } else {
        next.delete(feedId)
      }
      return next
    })
  }

  const handleToggleAll = () => {
    if (allSelected) {
      setSelectedFeedIds(new Set())
      return
    }

    setSelectedFeedIds(new Set(feedOptions.map((option) => option.feedId)))
  }

  const handleSubmit = async () => {
    if (selectedFeedIds.size === 0) {
      toast.message(t("byok_processing.rescore_feeds.empty_selection"))
      return
    }

    if (eligibleEntryCount === 0) {
      toast.message(t("byok_processing.rescore_feeds.empty"))
      return
    }

    const feedCount = selectedFeedIds.size
    const confirmed = window.confirm(
      t("byok_processing.rescore_feeds.confirm", {
        feedCount,
        entryCount: eligibleEntryCount,
      }),
    )
    if (!confirmed) return

    setIsSubmitting(true)
    try {
      const count = await entryEnrichmentService.rescoreFeeds({
        feedIds: Array.from(selectedFeedIds),
        actionLanguage: getActionLanguage(),
      })
      toast.success(t("byok_processing.rescore_feeds.started", { count }))
      onSuccess()
    } catch (error) {
      console.warn("[quality-score] Feed rescore failed:", error)
      toast.error(t("byok_processing.rescore_feeds.failed"))
    } finally {
      setIsSubmitting(false)
    }
  }

  if (feedOptions.length === 0) {
    return (
      <p className="text-sm text-text-secondary">{t("byok_processing.rescore_feeds.no_feeds")}</p>
    )
  }

  return (
    <div className="flex max-h-[min(70vh,520px)] flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">
          {t("byok_processing.rescore_feeds.description")}
        </p>
        <Button variant="ghost" size="sm" onClick={handleToggleAll}>
          {allSelected
            ? t("byok_processing.rescore_feeds.clear_all")
            : t("byok_processing.rescore_feeds.select_all")}
        </Button>
      </div>

      <ScrollArea rootClassName="min-h-0 flex-1" viewportClassName="max-h-[360px] pr-3">
        <div className="space-y-1">
          {feedOptions.map((option) => {
            const checked = selectedFeedIds.has(option.feedId)

            return (
              <label
                key={option.feedId}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 transition-colors",
                  checked ? "bg-fill-secondary" : "hover:bg-fill-tertiary",
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(value) => toggleFeed(option.feedId, value === true)}
                />
                <FeedIcon
                  fallback
                  target={getFeedById(option.feedId)}
                  size={20}
                  className="size-5 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-text">{option.title}</span>
              </label>
            )
          })}
        </div>
      </ScrollArea>

      <div className="flex items-center justify-between gap-3 border-t border-fill-secondary pt-4">
        <p className="text-xs text-text-tertiary">
          {t("byok_processing.rescore_feeds.selection_summary", {
            feedCount: selectedFeedIds.size,
            entryCount: eligibleEntryCount,
          })}
        </p>
        <Button
          size="sm"
          disabled={isSubmitting || selectedFeedIds.size === 0 || eligibleEntryCount === 0}
          onClick={() => void handleSubmit()}
        >
          {isSubmitting
            ? t("byok_processing.rescore_feeds.running")
            : t("byok_processing.rescore_feeds.action")}
        </Button>
      </div>
    </div>
  )
}
