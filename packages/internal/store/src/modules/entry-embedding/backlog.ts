import { getEntry } from "../entry/getter"
import { useEntryStore } from "../entry/store"
import { getSubscriptionByEntryId } from "../subscription/getter"
import { hasEmbeddingEligibleText, isEmbeddingStaleForEntry } from "./source-text"
import { entryEmbeddingActions } from "./store"

export type EmbeddingCoverageStats = {
  backlogCount: number
  coveredCount: number
  eligibleCount: number
}

export const entryNeedsEmbedding = (entryId: string) => {
  const entry = getEntry(entryId)
  if (!entry || entry.read) return false
  if (!getSubscriptionByEntryId(entryId)) return false
  if (!hasEmbeddingEligibleText(entry)) return false

  const existing = entryEmbeddingActions.getEmbedding(entryId)
  if (!existing) return true

  return isEmbeddingStaleForEntry(entry, existing)
}

export const countEmbeddingBacklog = (isInPipeline: (entryId: string) => boolean) => {
  const entries = Object.values(useEntryStore.getState().data)

  return entries.filter((entry) => {
    if (isInPipeline(entry.id)) return false

    return entryNeedsEmbedding(entry.id)
  }).length
}

export const getEmbeddingCoverageStats = (
  isInPipeline: (entryId: string) => boolean,
): EmbeddingCoverageStats => {
  const entries = Object.values(useEntryStore.getState().data)
  let eligibleCount = 0
  let coveredCount = 0
  let backlogCount = 0

  for (const entry of entries) {
    if (entry.read || !hasEmbeddingEligibleText(entry)) continue
    if (!getSubscriptionByEntryId(entry.id)) continue

    eligibleCount += 1
    const existing = entryEmbeddingActions.getEmbedding(entry.id)
    const isStale = existing ? isEmbeddingStaleForEntry(entry, existing) : true

    if (existing && !isStale) {
      coveredCount += 1
    }

    if (!isInPipeline(entry.id) && (!existing || isStale)) {
      backlogCount += 1
    }
  }

  return { backlogCount, coveredCount, eligibleCount }
}

export const listRebuildEligibleEntryIds = () =>
  Object.values(useEntryStore.getState().data)
    .filter((entry) => getSubscriptionByEntryId(entry.id))
    .filter((entry) => !entry.read && hasEmbeddingEligibleText(entry))
    .map((entry) => entry.id)
