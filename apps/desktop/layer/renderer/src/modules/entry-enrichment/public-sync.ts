import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { useEntryStore } from "@follow/store/entry/store"
import { useEntryEmbeddingStore } from "@follow/store/entry-embedding/store"
import { useEntryQualityScoreStore } from "@follow/store/entry-quality-score/store"
import { useEntryAiTagsStore } from "@follow/store/entry-tags/store"
import { useSummaryStore } from "@follow/store/summary/store"
import { useTranslationStore } from "@follow/store/translation/store"
import { useEffect, useRef } from "react"

import { getActionLanguage } from "~/atoms/settings/general"

type EnrichmentPayload = Record<
  string,
  {
    summary?: string | null
    /** Why this entry was selected — distinct from content summary */
    recommendationReason?: string | null
    tags?: string[]
    qualityScore?: number | null
    qualityTier?: string | null
    /** Selection status derived from qualityScore */
    selected?: "selected" | "watch" | "noise" | null
    qualityDetails?: {
      contentTypes?: Record<string, number>
      scores?: Record<string, number>
      positiveReasons?: string[]
      negativeReasons?: string[]
      confidence?: number
      summary?: string
    }
    translation?: {
      title?: string | null
      description?: string | null
      content?: string | null
      readabilityContent?: string | null
    }
    embedding?: number[]
  }
>

function collectEnrichments(): EnrichmentPayload {
  const summaryData = useSummaryStore.getState().data
  const tagsData = useEntryAiTagsStore.getState().data
  const qualityData = useEntryQualityScoreStore.getState().data
  const embeddingData = useEntryEmbeddingStore.getState().data
  const translationData = useTranslationStore.getState().data
  const entryData = useEntryStore.getState().data
  const language = getActionLanguage()

  const payload: EnrichmentPayload = {}

  const entryIds = Object.keys(entryData)
  for (const entryId of entryIds) {
    const enrichment: EnrichmentPayload[string] = {}
    let hasData = false

    const summaryEntry = summaryData[entryId]?.[language]
    if (summaryEntry?.summary) {
      enrichment.summary = summaryEntry.readabilitySummary || summaryEntry.summary
      hasData = true
    }

    const tags = tagsData[entryId]
    if (tags?.length) {
      enrichment.tags = tags.map((t) => t.label)
      hasData = true
    }

    const quality = qualityData[entryId]
    if (quality) {
      enrichment.qualityScore = quality.quality_score
      const tier =
        quality.quality_score >= 70 ? "high" : quality.quality_score >= 40 ? "medium" : "low"
      enrichment.qualityTier = tier
      enrichment.selected =
        quality.quality_score >= 70
          ? "selected"
          : quality.quality_score >= 40
            ? "watch"
            : "noise"
      enrichment.qualityDetails = {
        contentTypes: quality.content_types,
        scores: quality.scores,
        positiveReasons: quality.positive_reasons,
        negativeReasons: quality.negative_reasons,
        confidence: quality.confidence,
        summary: quality.summary,
      }
      // Derive recommendation reason from top positive reasons if no explicit one
      if (quality.positive_reasons?.length) {
        enrichment.recommendationReason = quality.positive_reasons.slice(0, 2).join("; ")
      }
      hasData = true
    }

    const translation = translationData[entryId]?.[language]
    if (
      translation?.title ||
      translation?.description ||
      translation?.content ||
      translation?.readabilityContent
    ) {
      enrichment.translation = {
        title: translation.title,
        description: translation.description,
        content: translation.content,
        readabilityContent: translation.readabilityContent,
      }
      hasData = true
    }

    const embedding = embeddingData[entryId]
    if (embedding?.vector?.length) {
      enrichment.embedding = embedding.vector
      hasData = true
    }

    if (hasData) {
      payload[entryId] = enrichment
    }
  }

  return payload
}

async function syncToServer() {
  const payload = collectEnrichments()
  const count = Object.keys(payload).length
  if (count === 0) return

  try {
    await fetch("/api/public/sync-enrichment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  } catch {
    // Sync failures are non-critical
  }
}

const SYNC_INTERVAL_MS = 3 * 60 * 1000

export function usePublicEnrichmentSync() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!LOCAL_RSS_MODE) return

    // Initial sync after 10s delay
    const initialTimer = setTimeout(() => {
      void syncToServer()
    }, 10_000)

    // Periodic sync
    timerRef.current = setInterval(() => {
      void syncToServer()
    }, SYNC_INTERVAL_MS)

    return () => {
      clearTimeout(initialTimer)
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])
}
