import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { cn } from "@follow/utils/utils"
import { useCallback } from "react"

import type { PlatformFilter } from "../atoms/platform-filter"
import { PLATFORM_LABELS, usePlatformFilter, useSetPlatformFilter } from "../atoms/platform-filter"

const TABS: PlatformFilter[] = ["all", "xueqiu", "weibo", "twitter", "wechat", "other"]

export const PlatformFilterTabs = () => {
  if (!LOCAL_RSS_MODE) return null

  return <PlatformFilterTabsInner />
}

const PlatformFilterTabsInner = () => {
  const activeFilter = usePlatformFilter()
  const setFilter = useSetPlatformFilter()

  return (
    <div className="flex items-center gap-1 px-4 pb-2 pt-1">
      {TABS.map((tab) => (
        <TabButton key={tab} tab={tab} isActive={activeFilter === tab} onClick={setFilter} />
      ))}
    </div>
  )
}

const TabButton = ({
  tab,
  isActive,
  onClick,
}: {
  tab: PlatformFilter
  isActive: boolean
  onClick: (tab: PlatformFilter) => void
}) => {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onClick(tab)
    },
    [onClick, tab],
  )

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
        isActive
          ? "border border-accent/30 bg-accent/15 text-accent"
          : "border border-transparent text-text-secondary hover:bg-fill-secondary hover:text-text",
      )}
    >
      {PLATFORM_LABELS[tab]}
    </button>
  )
}
