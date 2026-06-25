import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { entryActions } from "@follow/store/entry/store"
import type { ClusterableItem } from "@follow/store/entry-embedding/cluster"
import { clusterEntries } from "@follow/store/entry-embedding/cluster"
import { useEntryEmbeddingStore } from "@follow/store/entry-embedding/store"
import { useAtomValue, useSetAtom } from "jotai"
import { useMemo } from "react"

import type { ClusterMap } from "../atoms/entry-clusters"
import { clusterMapAtom, expandedClusterLeadersAtom } from "../atoms/entry-clusters"

/**
 * Given a list of sorted entry IDs, compute clusters from their embeddings
 * and return the filtered list (leaders + unclustered + expanded members).
 */
export function useEntryClusters(sortedEntryIds: string[]): {
  displayIds: string[]
  clusterMap: ClusterMap
} {
  const embeddingData = useEntryEmbeddingStore((state) => state.data)
  const expandedLeaders = useAtomValue(expandedClusterLeadersAtom)
  const setClusterMap = useSetAtom(clusterMapAtom)

  const clusterMap = useMemo(() => {
    if (!LOCAL_RSS_MODE || sortedEntryIds.length === 0) {
      return {
        memberOf: {},
        leaders: {},
        hiddenByCluster: new Set<string>(),
        expandedLeaders,
      }
    }

    const entries = entryActions.getFlattenMapEntries()

    const items: ClusterableItem[] = sortedEntryIds
      .map((id): ClusterableItem | null => {
        const emb = embeddingData[id]
        const entry = entries[id]
        if (!emb?.vector?.length || !entry) return null
        return {
          entryId: id,
          vector: emb.vector,
          publishedAt: entry.publishedAt.getTime(),
          feedId: entry.feedId,
          title: entry.title,
        }
      })
      .filter((x): x is ClusterableItem => x !== null)

    if (items.length < 2) {
      return {
        memberOf: {},
        leaders: {},
        hiddenByCluster: new Set<string>(),
        expandedLeaders,
      }
    }

    const result = clusterEntries(items)

    const memberOf: Record<string, (typeof result.clusters)[number]> = {}
    const leaders: Record<string, (typeof result.clusters)[number]> = {}
    const hiddenByCluster = new Set<string>()

    for (const cluster of result.clusters) {
      const leaderId = cluster.entryIds[0]!
      leaders[leaderId] = cluster
      for (const eid of cluster.entryIds) {
        memberOf[eid] = cluster
        if (eid !== leaderId && !expandedLeaders.has(leaderId)) {
          hiddenByCluster.add(eid)
        }
      }
    }

    const map: ClusterMap = { memberOf, leaders, hiddenByCluster, expandedLeaders }
    return map
  }, [sortedEntryIds, embeddingData, expandedLeaders])

  useMemo(() => {
    setClusterMap(clusterMap)
  }, [clusterMap, setClusterMap])

  const displayIds = useMemo(() => {
    if (clusterMap.hiddenByCluster.size === 0) return sortedEntryIds
    return sortedEntryIds.filter((id) => !clusterMap.hiddenByCluster.has(id))
  }, [sortedEntryIds, clusterMap.hiddenByCluster])

  return { displayIds, clusterMap }
}
