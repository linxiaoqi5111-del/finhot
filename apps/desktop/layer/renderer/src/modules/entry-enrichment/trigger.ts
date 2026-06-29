import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { applyLocalActionRulesToEntry } from "@follow/store/action/local"
import { useActionStore } from "@follow/store/action/store"
import { entryEnrichmentService } from "@follow/store/enrichment/service"
import type { EnrichmentPhase } from "@follow/store/enrichment/types"
import { useEntryStore } from "@follow/store/entry/store"
import { entryEmbeddingJobService } from "@follow/store/entry-embedding/job-service"
import { entryRankScoreSyncService } from "@follow/store/entry-rank-score/store"
import { getFeedByIdOrUrl } from "@follow/store/feed/getter"
import { getSubscriptionByFeedId } from "@follow/store/subscription/getter"

import { getAISettings } from "~/atoms/settings/ai"
import { getActionLanguage, getGeneralSettings } from "~/atoms/settings/general"
import { resolveConfiguredByokProvider } from "~/modules/settings/tabs/ai/byok/constants"

/**
 * Remove entries whose feed is matched by a "skip AI enrichment" action rule.
 *
 * This is the single source of truth that gates every BYOK enrichment path
 * (initial ingest, refetch, and the periodic visible-entry backfill). Rank
 * scoring is a local heuristic and is intentionally NOT gated here, so ordering
 * stays consistent. Entries that are not yet in the store are passed through
 * unchanged (they cannot be evaluated and will be re-checked once loaded).
 */
export const filterEnrichableEntryIds = (entryIds: string[]): string[] => {
  const { rules } = useActionStore.getState()
  if (rules.length === 0) return entryIds

  const entryData = useEntryStore.getState().data
  return entryIds.filter((id) => {
    const entry = entryData[id]
    if (!entry) return true
    const feedId = entry.feedId ?? undefined
    const { skipEnrichment } = applyLocalActionRulesToEntry(entry, {
      feed: getFeedByIdOrUrl({ id: feedId }),
      subscription: getSubscriptionByFeedId(feedId),
      view: getSubscriptionByFeedId(feedId)?.view,
      rules,
    })
    return !skipEnrichment
  })
}

export const getByokPhases = (): EnrichmentPhase[] => {
  const { summary, translation, autoTag, qualityScore } = getGeneralSettings()
  const phases: EnrichmentPhase[] = []

  if (summary) phases.push("summary")
  if (translation) phases.push("titleTranslation")
  if (autoTag) phases.push("tags")
  if (qualityScore) phases.push("qualityScore")

  return phases
}

const isByokAvailable = () => {
  const aiSettings = getAISettings()
  return !!resolveConfiguredByokProvider(aiSettings.byok)
}

const isEmbeddingEnabled = () => LOCAL_RSS_MODE && (getAISettings().embedding?.enabled ?? false)

export const triggerEntryEnrichmentFromIngest = (entryIds: string[]) => {
  if (entryIds.length === 0) return

  const enrichableIds = filterEnrichableEntryIds(entryIds)
  if (enrichableIds.length === 0) return

  const byokPhases = getByokPhases()
  if (byokPhases.length > 0 && isByokAvailable()) {
    entryEnrichmentService.enqueueFromIngest({
      entryIds: enrichableIds,
      actionLanguage: getActionLanguage(),
      phases: byokPhases,
      translationMode: getGeneralSettings().translationMode,
    })
  }

  if (isEmbeddingEnabled()) {
    entryEmbeddingJobService.enqueueFromIngest({ entryIds: enrichableIds })
  }
}

export const triggerEntryEnrichmentBackfill = (entryIds: string[]) => {
  if (entryIds.length === 0) return

  // Exclude entries whose feed opted out of AI enrichment via an action rule. The backfill
  // re-checks every visible entry on mount/refetch and on a periodic timer, so it must honor
  // the skip rule too — otherwise refetching would re-enrich a feed the user marked no-AI.
  const enrichableIds = filterEnrichableEntryIds(entryIds)
  if (enrichableIds.length === 0) return

  // Backfill only unread entries. Already-read content won't benefit from AI enrichment
  // (the user won't see summaries/tags for content they've already consumed), and skipping
  // them avoids unnecessary BYOK token usage — especially important after initial feed
  // subscription where historical entries are pre-marked as read.
  const entryData = useEntryStore.getState().data
  const unreadIds = enrichableIds.filter((id) => {
    const entry = entryData[id]
    return entry && !entry.read
  })

  if (unreadIds.length === 0) return

  const byokPhases = getByokPhases()
  if (byokPhases.length > 0 && isByokAvailable()) {
    entryEnrichmentService.backfillVisible({
      entryIds: unreadIds,
      actionLanguage: getActionLanguage(),
      phases: byokPhases,
      translationMode: getGeneralSettings().translationMode,
    })
  }

  if (isEmbeddingEnabled()) {
    entryEmbeddingJobService.backfillVisible({ entryIds: unreadIds })
  }
}

export const triggerEntryRankFromIngest = (entryIds: string[]) => {
  if (entryIds.length === 0) return

  void entryRankScoreSyncService.recomputeForEntries(entryIds, { onlyMissing: true })
}

export const triggerEntryRankBackfill = (entryIds: string[]) => {
  if (entryIds.length === 0) return

  void entryRankScoreSyncService.recomputeForEntries(entryIds, { onlyMissing: true })
}
