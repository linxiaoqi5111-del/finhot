import { Spring } from "@follow/components/constants/spring.js"
import { ScrollArea } from "@follow/components/ui/scroll-area/index.js"
import { useEntryStore } from "@follow/store/entry/store"
import { cn } from "@follow/utils/utils"
import { AnimatePresence } from "motion/react"
import { memo, useCallback, useState } from "react"

import { m } from "~/components/common/Motion"
import { ROUTE_VIEW_ALL } from "~/constants"
import { useNavigateEntry } from "~/hooks/biz/useNavigateEntry"

import type { RadarTopic } from "./useRadarTopics"
import { useRadarTopics } from "./useRadarTopics"

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return `${days}天前`
}

function getHeatColor(heat: number): string {
  if (heat >= 8) return "text-red"
  if (heat >= 5) return "text-orange"
  if (heat >= 3) return "text-yellow"
  return "text-green"
}

function getHeatIndicator(heat: number): string {
  if (heat >= 8) return "🔴"
  if (heat >= 5) return "🟠"
  if (heat >= 3) return "🟡"
  return "🟢"
}

const TopicCard = memo(
  ({
    topic,
    isExpanded,
    onToggle,
  }: {
    topic: RadarTopic
    isExpanded: boolean
    onToggle: () => void
  }) => {
    const navigateEntry = useNavigateEntry()

    const handleEntryClick = useCallback(
      (entryId: string) => {
        navigateEntry({
          timelineId: ROUTE_VIEW_ALL,
          feedId: topic.sourceFeedIds[0] || "",
          entryId,
        })
      },
      [navigateEntry, topic.sourceFeedIds],
    )

    return (
      <m.div
        layout
        initial={{ y: 8, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: -4, opacity: 0 }}
        transition={Spring.presets.snappy}
        className="group relative overflow-hidden rounded-xl"
        style={{
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: "hsl(var(--fo-a) / 0.15)",
          boxShadow: "0 4px 16px hsl(var(--fo-a) / 0.04), 0 2px 8px rgba(0, 0, 0, 0.06)",
        }}
      >
        {/* Inner glow */}
        <div
          className="pointer-events-none absolute inset-0 rounded-xl"
          style={{
            background: "linear-gradient(to bottom right, hsl(var(--fo-a) / 0.03), transparent)",
          }}
        />

        <button
          type="button"
          className="relative flex w-full cursor-pointer items-start gap-3 p-3 text-left transition-colors hover:bg-fill-quaternary"
          onClick={onToggle}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="line-clamp-2 text-sm font-medium leading-tight text-text">
                {topic.title}
              </span>
              <span className="shrink-0 text-xs tabular-nums">
                {getHeatIndicator(topic.heat)}{" "}
                <span className={cn("font-medium", getHeatColor(topic.heat))}>
                  {topic.sourceCount}源
                </span>
              </span>
            </div>

            <div className="flex flex-wrap gap-1">
              {topic.sourceNames.slice(0, 5).map((name, i) => (
                <span
                  key={i}
                  className="inline-flex items-center rounded-md bg-fill-tertiary px-1.5 py-0.5 text-[11px] text-text-secondary"
                >
                  {name.length > 8 ? `${name.slice(0, 8)}…` : name}
                </span>
              ))}
              {topic.sourceNames.length > 5 && (
                <span className="inline-flex items-center rounded-md bg-fill-tertiary px-1.5 py-0.5 text-[11px] text-text-tertiary">
                  +{topic.sourceNames.length - 5}
                </span>
              )}
            </div>

            <div className="flex items-center gap-3 text-[11px] text-text-tertiary">
              <span>{formatRelativeTime(topic.latestAt)}</span>
              <span>{topic.size}条</span>
              {topic.avgQualityScore !== null && <span>质量 {topic.avgQualityScore}</span>}
            </div>
          </div>

          <i
            className={cn(
              "i-lucide-chevron-down mt-1 size-4 shrink-0 text-text-tertiary transition-transform",
              isExpanded && "rotate-180",
            )}
          />
        </button>

        <AnimatePresence>
          {isExpanded && (
            <m.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={Spring.presets.smooth}
              className="overflow-hidden"
            >
              <div
                className="mx-3 h-px"
                style={{
                  background:
                    "linear-gradient(to right, transparent, hsl(var(--fo-a) / 0.15), transparent)",
                }}
              />
              <div className="flex flex-col gap-1 p-3 pt-2">
                {topic.entryIds.slice(0, 8).map((entryId) => (
                  <TopicEntryItem
                    key={entryId}
                    entryId={entryId}
                    onClick={() => handleEntryClick(entryId)}
                  />
                ))}
                {topic.entryIds.length > 8 && (
                  <span className="px-2 py-1 text-[11px] text-text-quaternary">
                    还有 {topic.entryIds.length - 8} 条…
                  </span>
                )}
              </div>
            </m.div>
          )}
        </AnimatePresence>
      </m.div>
    )
  },
)
TopicCard.displayName = "TopicCard"

const TopicEntryItem = memo(({ entryId, onClick }: { entryId: string; onClick: () => void }) => {
  const entry = useEntryStore(useCallback((state) => state.data[entryId], [entryId]))

  if (!entry) return null

  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-fill-quaternary"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
        {entry.title || "(无标题)"}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-text-quaternary">
        {formatRelativeTime(entry.publishedAt?.getTime?.() ?? 0)}
      </span>
    </button>
  )
})
TopicEntryItem.displayName = "TopicEntryItem"

export const RadarPanel = memo(() => {
  const { topics } = useRadarTopics()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-fill-secondary px-4 py-3">
        <div className="flex items-center gap-2">
          <i className="i-lucide-radar size-5 text-purple" />
          <h2 className="text-base font-semibold text-text">热点雷达</h2>
        </div>
        <span className="text-xs tabular-nums text-text-tertiary">{topics.length} 个话题</span>
      </div>

      {/* Content */}
      <ScrollArea.ScrollArea rootClassName="flex-1" viewportClassName="p-3">
        {topics.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <i className="i-lucide-radar size-12 text-text-quaternary" />
            <div className="text-sm text-text-tertiary">暂无热点话题</div>
            <div className="max-w-[240px] text-xs text-text-quaternary">
              需要更多订阅内容和 AI 嵌入计算后才能聚合话题
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <AnimatePresence mode="popLayout">
              {topics.map((topic) => (
                <TopicCard
                  key={topic.id}
                  topic={topic}
                  isExpanded={expandedId === topic.id}
                  onToggle={() => toggleExpand(topic.id)}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </ScrollArea.ScrollArea>
    </div>
  )
})
RadarPanel.displayName = "RadarPanel"
