import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { entryActions, useEntryStore } from "@follow/store/entry/store"
import type { ClusterableItem } from "@follow/store/entry-embedding/cluster"
import { clusterEntries } from "@follow/store/entry-embedding/cluster"
import { useEntryEmbeddingStore } from "@follow/store/entry-embedding/store"
import { useEntryQualityScoreStore } from "@follow/store/entry-quality-score/store"
import { getFeedById } from "@follow/store/feed/getter"
import { useMemo } from "react"

export type RadarTopic = {
  id: string
  title: string
  /** Number of unique source feeds covering this topic */
  sourceCount: number
  /** Feed IDs involved */
  sourceFeedIds: string[]
  /** Source feed names for display */
  sourceNames: string[]
  /** All entry IDs in this topic cluster */
  entryIds: string[]
  /** Heat score: sourceCount * recency factor */
  heat: number
  /** Earliest entry time */
  earliestAt: number
  /** Latest entry time */
  latestAt: number
  /** Average quality score of entries in this cluster */
  avgQualityScore: number | null
  /** Total entry count */
  size: number
}

const ONE_HOUR = 3600_000
const EIGHTEEN_HOURS = 18 * ONE_HOUR
const TWELVE_HOURS = 12 * ONE_HOUR
const ONE_DAY = 24 * ONE_HOUR

function computeHeat(sourceCount: number, latestAt: number, size: number): number {
  const age = Date.now() - latestAt
  // Recency decay: full weight within 1h, half at 12h, quarter at 24h
  let recency = 1
  if (age > ONE_DAY) recency = 0.25
  else if (age > TWELVE_HOURS) recency = 0.5
  else if (age > ONE_HOUR) recency = 0.75

  // Heat = sources^1.5 * recency * log(size+1)
  return Math.pow(sourceCount, 1.5) * recency * Math.log2(size + 1)
}

/**
 * Aggregates all local entries into hot topic clusters using embeddings.
 * Returns topics sorted by heat (descending).
 */
export function useRadarTopics(): { topics: RadarTopic[]; isReady: boolean } {
  const embeddingData = useEntryEmbeddingStore((state) => state.data)
  const qualityScores = useEntryQualityScoreStore((state) => state.data)
  const entryCount = useEntryStore((state) => state.entryIdSet.size)

  const topics = useMemo(() => {
    if (!LOCAL_RSS_MODE) return []

    void entryCount // trigger recompute on entry changes

    const entries = entryActions.getFlattenMapEntries()
    const entryIds = Object.keys(entries)

    if (entryIds.length < 3) return []

    // Only cluster entries from the last 3 days
    const cutoff = Date.now() - 3 * ONE_DAY
    const items: ClusterableItem[] = []

    for (const id of entryIds) {
      const entry = entries[id]
      const emb = embeddingData[id]
      if (!entry || !emb?.vector?.length) continue
      if (entry.publishedAt.getTime() < cutoff) continue

      items.push({
        entryId: id,
        vector: emb.vector,
        publishedAt: entry.publishedAt.getTime(),
        feedId: entry.feedId,
        title: entry.title,
      })
    }

    if (items.length < 3) return []

    // Use a slightly lower threshold for broader topic grouping
    // maxTimeGap: 18h — covers overnight gap (收盘3pm → 次日开盘9:30am)
    const result = clusterEntries(items, { tau: 0.78, minSize: 2, maxTimeGap: EIGHTEEN_HOURS })

    const radarTopics: RadarTopic[] = result.clusters.map((cluster) => {
      const { sourceFeedIds } = cluster
      const sourceNames = sourceFeedIds.map((fid) => {
        const feed = getFeedById(fid)
        return feed?.title || feed?.url || fid
      })

      const entryTimes = cluster.entryIds.map((eid) => {
        const e = entries[eid]
        return e?.publishedAt.getTime() ?? 0
      })
      const earliestAt = Math.min(...entryTimes)
      const latestAt = Math.max(...entryTimes)

      // Average quality score
      let totalScore = 0
      let scoredCount = 0
      for (const eid of cluster.entryIds) {
        const qs = qualityScores[eid]
        if (qs) {
          totalScore += qs.quality_score
          scoredCount++
        }
      }
      const avgQualityScore = scoredCount > 0 ? Math.round(totalScore / scoredCount) : null

      const heat = computeHeat(sourceFeedIds.length, latestAt, cluster.size)

      return {
        id: cluster.id,
        title: cluster.title,
        sourceCount: sourceFeedIds.length,
        sourceFeedIds,
        sourceNames,
        entryIds: cluster.entryIds,
        heat,
        earliestAt,
        latestAt,
        avgQualityScore,
        size: cluster.size,
      }
    })

    // Sort by heat descending
    radarTopics.sort((a, b) => b.heat - a.heat)
    return radarTopics
  }, [embeddingData, qualityScores, entryCount])

  return { topics, isReady: topics.length > 0 || !LOCAL_RSS_MODE }
}
