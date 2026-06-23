import type { EntryQualityScoreRecord } from "@follow/shared/entry-quality-score"

const SOCIAL_PLATFORM_PATTERNS = [
  /^finhot:\/\/twitter\//,
  /^finhot:\/\/xueqiu\//,
  /\/weibo\/user\//,
] as const

/**
 * Returns true if the feed URL belongs to a social platform
 * that should have quality score admission filtering (Twitter, Weibo, Xueqiu).
 */
export function isSocialPlatformFeedUrl(feedUrl: string | undefined | null): boolean {
  if (!feedUrl) return false
  return SOCIAL_PLATFORM_PATTERNS.some((pattern) => pattern.test(feedUrl))
}

/**
 * Given a set of entry IDs, filters out entries from social platform feeds
 * whose quality score is below the given threshold.
 *
 * Entries without a quality score yet (pending AI evaluation) are kept.
 */
export function filterByAdmissionThreshold({
  entryIds,
  threshold,
  qualityScores,
  getEntryFeedUrl,
}: {
  entryIds: string[]
  threshold: number
  qualityScores: Record<string, EntryQualityScoreRecord>
  getEntryFeedUrl: (entryId: string) => string | undefined | null
}): string[] {
  if (threshold <= 0) return entryIds

  return entryIds.filter((entryId) => {
    const feedUrl = getEntryFeedUrl(entryId)
    if (!isSocialPlatformFeedUrl(feedUrl)) return true

    const score = qualityScores[entryId]
    // Entry hasn't been scored yet — keep it (will be filtered on next re-render once scored)
    if (!score) return true

    return score.quality_score >= threshold
  })
}
