import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { entryEnrichmentService } from "@follow/store/enrichment/service"
import type { EnrichmentPhase } from "@follow/store/enrichment/types"
import { useEntryStore } from "@follow/store/entry/store"
import { entryEmbeddingJobService } from "@follow/store/entry-embedding/job-service"
import { entryRankScoreSyncService } from "@follow/store/entry-rank-score/store"

import { getAISettings } from "~/atoms/settings/ai"
import { getActionLanguage, getGeneralSettings } from "~/atoms/settings/general"
import { resolveConfiguredByokProvider } from "~/modules/settings/tabs/ai/byok/constants"

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

  const byokPhases = getByokPhases()
  if (byokPhases.length > 0 && isByokAvailable()) {
    entryEnrichmentService.enqueueFromIngest({
      entryIds,
      actionLanguage: getActionLanguage(),
      phases: byokPhases,
      translationMode: getGeneralSettings().translationMode,
    })
  }

  if (isEmbeddingEnabled()) {
    entryEmbeddingJobService.enqueueFromIngest({ entryIds })
  }
}

export const triggerEntryEnrichmentBackfill = (entryIds: string[]) => {
  if (entryIds.length === 0) return

  // Backfill only unread entries. Already-read content won't benefit from AI enrichment
  // (the user won't see summaries/tags for content they've already consumed), and skipping
  // them avoids unnecessary BYOK token usage — especially important after initial feed
  // subscription where historical entries are pre-marked as read.
  const entryData = useEntryStore.getState().data
  const unreadIds = entryIds.filter((id) => {
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
