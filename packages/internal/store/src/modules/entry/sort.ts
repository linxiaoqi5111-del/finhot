import type { BehaviorEventType } from "@follow/shared/behavior-events"
import type { EntryTimelineSortMode } from "@follow/shared/entry-rank-score"
import { filterRecommendedEntryIds, sortEntryIdsByRank } from "@follow/shared/entry-rank-score"

import { useBehaviorEventStore } from "../behavior-event/store"
import { getEntryCollections } from "../collection/getter"
import { entryQualityScoreActions } from "../entry-quality-score/store"
import { getEntryRankSortContext } from "../entry-rank-score/store"
import { useEntryStore } from "./store"

const getEntryFromStore = (entryId: string) => useEntryStore.getState().data[entryId]

const parseDate = (value: Date | string | null | undefined): Date | undefined => {
  if (!value) return
  if (value instanceof Date) return value

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return
  return date
}

const getLatestBehaviorEventAt = (
  entryId: string,
  eventType: BehaviorEventType,
): Date | undefined => {
  const { events } = useBehaviorEventStore.getState()

  for (const event of [...events].reverse()) {
    if (event?.entryId === entryId && event.eventType === eventType) {
      return parseDate(event.createdAt)
    }
  }
}

export function sortEntryIdsByPublishDate(a: string, b: string) {
  const entryA = getEntryFromStore(a)
  const entryB = getEntryFromStore(b)
  if (!entryA || !entryB) return 0
  return entryB.publishedAt.getTime() - entryA.publishedAt.getTime()
}

export function sortEntryIdsByRecommended(entryIds: string[], options?: { now?: Date }) {
  const context = getEntryRankSortContext()
  const recommendedEntryIds = filterRecommendedEntryIds({
    entryIds,
    now: options?.now,
    getPublishedAt: context.getPublishedAt,
    getInsertedAt: (entryId) => getEntryFromStore(entryId)?.insertedAt,
    getQualityRecord: (entryId) => entryQualityScoreActions.getScore(entryId),
    getEntryState: context.getEntryState,
    getReadCompletedAt: (entryId) => getLatestBehaviorEventAt(entryId, "read_complete"),
    getStarredAt: (entryId) => parseDate(getEntryCollections(entryId)?.createdAt),
    getNotInterestedAt: (entryId) => getLatestBehaviorEventAt(entryId, "not_interested"),
  })

  return sortEntryIdsByRank({
    entryIds: recommendedEntryIds,
    getBaseRank: context.getBaseRank,
    getPublishedAt: context.getPublishedAt,
    getEntryState: context.getEntryState,
  })
}

export function sortEntryIds(entryIds: string[], mode: EntryTimelineSortMode) {
  if (mode === "recommended") {
    return sortEntryIdsByRecommended(entryIds)
  }

  return [...entryIds].sort(sortEntryIdsByPublishDate)
}
