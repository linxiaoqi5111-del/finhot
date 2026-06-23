import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { cn } from "@follow/utils/utils"
import { useAtomValue, useSetAtom } from "jotai"
import { useCallback } from "react"

import { clusterMapAtom, expandedClusterLeadersAtom } from "../atoms/entry-clusters"

export const EntryClusterBadge = ({ entryId }: { entryId: string }) => {
  const clusterMap = useAtomValue(clusterMapAtom)
  const setExpanded = useSetAtom(expandedClusterLeadersAtom)

  const cluster = clusterMap.leaders[entryId]
  const isExpanded = clusterMap.expandedLeaders.has(entryId)

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(entryId)) {
        next.delete(entryId)
      } else {
        next.add(entryId)
      }
      return next
    })
  }, [entryId, setExpanded])

  if (!LOCAL_RSS_MODE || !cluster || cluster.size <= 1) return null

  const relatedCount = cluster.size - 1

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        toggle()
      }}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded px-1.5 py-0.5",
        "text-[11px] font-medium tabular-nums",
        "transition-colors hover:bg-accent/20",
        isExpanded ? "bg-accent/15 text-accent" : "bg-blue/10 text-blue",
      )}
    >
      <span>+{relatedCount} 相关</span>
    </button>
  )
}
