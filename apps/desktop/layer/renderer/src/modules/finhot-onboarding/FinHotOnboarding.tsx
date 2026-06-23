import { Spring } from "@follow/components/constants/spring.js"
import { Button } from "@follow/components/ui/button/index.js"
import { ScrollArea } from "@follow/components/ui/scroll-area/ScrollArea.js"
import type { FinanceFeed, FinanceFeedCategory } from "@follow/constants"
import { FeedViewType, FinanceFeedCategoryMap, PRESET_FINANCE_FEEDS } from "@follow/constants"
import { cn } from "@follow/utils/utils"
import { m } from "motion/react"
import { useCallback, useMemo, useState } from "react"

import focalLogoUrl from "~/assets/focal-logo.png"
import { previewLocalRssFeed } from "~/modules/local-rss/service"

type FeedWithSelected = FinanceFeed & { selected: boolean }

export function FinHotOnboarding({ onClose }: { onClose: () => void }) {
  const [feeds, setFeeds] = useState<FeedWithSelected[]>(() =>
    PRESET_FINANCE_FEEDS.map((f) => ({ ...f, selected: true })),
  )
  const [subscribing, setSubscribing] = useState(false)

  const categories = useMemo(() => {
    const cats = Object.keys(FinanceFeedCategoryMap) as FinanceFeedCategory[]
    return cats.map((cat) => ({
      ...FinanceFeedCategoryMap[cat],
      key: cat,
      feeds: feeds.filter((f) => f.category === cat),
    }))
  }, [feeds])

  const selectedCount = feeds.filter((f) => f.selected).length

  const toggleFeed = useCallback((url: string) => {
    setFeeds((prev) => prev.map((f) => (f.url === url ? { ...f, selected: !f.selected } : f)))
  }, [])

  const toggleCategory = useCallback((category: FinanceFeedCategory) => {
    setFeeds((prev) => {
      const catFeeds = prev.filter((f) => f.category === category)
      const allSelected = catFeeds.every((f) => f.selected)
      return prev.map((f) => (f.category === category ? { ...f, selected: !allSelected } : f))
    })
  }, [])

  const handleStart = useCallback(async () => {
    setSubscribing(true)
    const selectedFeeds = feeds.filter((f) => f.selected)

    for (const feed of selectedFeeds) {
      try {
        // Preview feed to get metadata, then subscribe + refresh to fetch entries
        const preview = await previewLocalRssFeed({ url: feed.url })
        const feedData = preview.feed
        const { upsertLocalRssSubscription } = await import("~/modules/local-rss/service")
        await upsertLocalRssSubscription({
          feed: { ...feedData, type: "feed" as const },
          subscription: {
            url: feed.url,
            view: FeedViewType.Articles,
            category: FinanceFeedCategoryMap[feed.category].label,
            isPrivate: false,
            hideFromTimeline: null,
            title: feed.title,
            feedId: feedData.id,
            listId: undefined,
          },
        })
      } catch (error) {
        console.error("Failed to subscribe", { feed: feed.title, error })
      }
    }

    onClose()
  }, [feeds, onClose])

  return (
    <m.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={Spring.presets.smooth}
      className="flex h-full max-h-[80vh] w-full max-w-[900px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-lg"
    >
      {/* Header */}
      <div className="flex items-center gap-4 border-b border-border px-8 py-6">
        <img src={focalLogoUrl} alt="FinHot" className="size-12 rounded-xl" />
        <div>
          <h1 className="text-xl font-bold text-text">欢迎使用 FinHot</h1>
          <p className="text-sm text-text-secondary">选择你感兴趣的金融信息源，开始监控热词</p>
        </div>
        <div className="ml-auto text-sm text-text-tertiary">
          已选 {selectedCount} / {feeds.length} 源
        </div>
      </div>

      {/* Feed Categories */}
      <ScrollArea flex rootClassName="flex-1 min-h-0" viewportClassName="px-8 py-6">
        <div className="space-y-6">
          {categories.map((cat) => {
            const allSelected = cat.feeds.every((f) => f.selected)
            return (
              <div key={cat.key}>
                <div className="mb-3 flex items-center gap-2">
                  <span className="text-lg">{cat.emoji}</span>
                  <span className="font-semibold text-text">{cat.label}</span>
                  <button
                    type="button"
                    onClick={() => toggleCategory(cat.key)}
                    className="ml-2 text-xs text-text-tertiary hover:text-text-secondary"
                  >
                    {allSelected ? "取消全选" : "全选"}
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {cat.feeds.map((feed) => (
                    <m.button
                      key={feed.url}
                      type="button"
                      onClick={() => toggleFeed(feed.url)}
                      whileTap={{ scale: 0.98 }}
                      className={cn(
                        "flex items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors",
                        feed.selected
                          ? "border-red/30 bg-red/5"
                          : "border-border bg-fill-quaternary hover:border-fill-tertiary",
                      )}
                    >
                      <div
                        className={cn(
                          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                          feed.selected ? "border-red bg-red text-white" : "border-fill-tertiary",
                        )}
                      >
                        {feed.selected && (
                          <svg className="size-3" viewBox="0 0 12 12" fill="none">
                            <path
                              d="M2.5 6L5 8.5L9.5 4"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-text">{feed.title}</div>
                        {feed.description && (
                          <div className="mt-0.5 truncate text-xs text-text-tertiary">
                            {feed.description}
                          </div>
                        )}
                      </div>
                    </m.button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </ScrollArea>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border px-8 py-4">
        <Button variant="ghost" onClick={onClose}>
          跳过
        </Button>
        <Button
          onClick={handleStart}
          disabled={subscribing || selectedCount === 0}
          buttonClassName="bg-red text-white hover:bg-red/90"
        >
          {subscribing ? "订阅中..." : `开始使用 (${selectedCount} 源)`}
        </Button>
      </div>
    </m.div>
  )
}
