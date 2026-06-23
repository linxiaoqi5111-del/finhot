import { getEntry } from "../entry/getter"
import { useEntryStore } from "../entry/store"
import type { EntryModel } from "../entry/types"
import { getSubscriptionByEntryId } from "../subscription/getter"
import { entryQualityScoreActions } from "./store"

export type QualityScoreCoverageStats = {
  backlogCount: number
  coveredCount: number
  eligibleCount: number
}

export const hasQualityScoreEligibleText = (
  entry: Pick<EntryModel, "title" | "content" | "description">,
) => {
  return Boolean(entry.title?.trim() || entry.content?.trim() || entry.description?.trim())
}

export const entryNeedsQualityScore = (entryId: string) => {
  const entry = getEntry(entryId)
  if (!entry || !hasQualityScoreEligibleText(entry)) return false
  if (!getSubscriptionByEntryId(entryId)) return false

  return !entryQualityScoreActions.getScore(entryId)
}

export const getQualityScoreCoverageStats = (
  isInPipeline: (entryId: string) => boolean,
): QualityScoreCoverageStats => {
  const entries = Object.values(useEntryStore.getState().data)
  let eligibleCount = 0
  let coveredCount = 0
  let backlogCount = 0

  for (const entry of entries) {
    if (!hasQualityScoreEligibleText(entry)) continue
    if (!getSubscriptionByEntryId(entry.id)) continue

    eligibleCount += 1

    if (entryQualityScoreActions.getScore(entry.id)) {
      coveredCount += 1
    }

    if (!isInPipeline(entry.id) && !entryQualityScoreActions.getScore(entry.id)) {
      backlogCount += 1
    }
  }

  return { backlogCount, coveredCount, eligibleCount }
}

export const listRescoreEligibleEntryIds = () =>
  Object.values(useEntryStore.getState().data)
    .filter((entry) => getSubscriptionByEntryId(entry.id))
    .filter((entry) => hasQualityScoreEligibleText(entry))
    .map((entry) => entry.id)

export const listRescoreEligibleEntryIdsByFeedIds = (feedIds: string[]) => {
  const feedIdSet = new Set(feedIds.filter(Boolean))
  if (feedIdSet.size === 0) return []

  return Object.values(useEntryStore.getState().data)
    .filter((entry) => entry.feedId && feedIdSet.has(entry.feedId))
    .filter((entry) => getSubscriptionByEntryId(entry.id))
    .filter((entry) => hasQualityScoreEligibleText(entry))
    .map((entry) => entry.id)
}
