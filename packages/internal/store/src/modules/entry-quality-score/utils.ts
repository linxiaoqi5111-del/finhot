import type {
  EntryQualityContentType,
  EntryQualityDimensionScores,
  EntryQualityScoreRecord,
} from "@follow/shared/entry-quality-score"
import {
  calculateQualityScore,
  ENTRY_QUALITY_CONTENT_TYPES,
} from "@follow/shared/entry-quality-score"

const DIMENSION_KEYS = [
  "information_gain",
  "depth",
  "evidence",
  "actionability",
  "originality",
  "signal_density",
] as const satisfies readonly (keyof EntryQualityDimensionScores)[]

const clampScore = (value: number) => Math.min(5, Math.max(0, Math.round(value)))

const parseDimensionScores = (raw: unknown): EntryQualityDimensionScores | null => {
  if (!raw || typeof raw !== "object") return null

  const record = raw as Record<string, unknown>
  const scores = {} as EntryQualityDimensionScores

  for (const key of DIMENSION_KEYS) {
    const value = record[key]
    if (typeof value !== "number" || !Number.isFinite(value)) return null
    scores[key] = clampScore(value)
  }

  return scores
}

const parseContentTypes = (raw: unknown): Partial<Record<EntryQualityContentType, number>> => {
  if (!raw || typeof raw !== "object") return {}

  const record = raw as Record<string, unknown>
  const contentTypes: Partial<Record<EntryQualityContentType, number>> = {}

  for (const [key, value] of Object.entries(record)) {
    if (!ENTRY_QUALITY_CONTENT_TYPES.includes(key as EntryQualityContentType)) continue
    if (typeof value !== "number" || !Number.isFinite(value)) continue
    contentTypes[key as EntryQualityContentType] = Math.min(1, Math.max(0, value))
  }

  return contentTypes
}

const parseStringArray = (raw: unknown, maxItems: number) => {
  if (!Array.isArray(raw)) return []

  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems)
}

const getContentTypeWeight = (
  contentTypes: Partial<Record<EntryQualityContentType, number>>,
  type: EntryQualityContentType,
) => contentTypes[type] ?? 0

export const applyContentTypeScoreCaps = (
  contentTypes: Partial<Record<EntryQualityContentType, number>>,
  scores: EntryQualityDimensionScores,
): EntryQualityDimensionScores => {
  const newsWeight = getContentTypeWeight(contentTypes, "News")
  const productUpdateWeight = getContentTypeWeight(contentTypes, "ProductUpdate")
  const practicalWeight =
    getContentTypeWeight(contentTypes, "Tutorial") + getContentTypeWeight(contentTypes, "Workflow")

  let adjusted = { ...scores }

  if (newsWeight >= 0.6) {
    adjusted = {
      ...adjusted,
      depth: Math.min(adjusted.depth, 2),
      actionability: Math.min(adjusted.actionability, 1),
      originality: Math.min(adjusted.originality, 2),
    }
  }

  if (newsWeight >= 0.75) {
    adjusted = {
      ...adjusted,
      information_gain: Math.min(adjusted.information_gain, 3),
    }
  }

  if (productUpdateWeight >= 0.5 && practicalWeight < 0.2) {
    adjusted = {
      ...adjusted,
      depth: Math.min(adjusted.depth, 2),
      actionability: Math.min(adjusted.actionability, 1),
    }
  }

  return adjusted
}

export const validateQualityScoreResult = (raw: unknown): EntryQualityScoreRecord | null => {
  if (!raw || typeof raw !== "object") return null

  const record = raw as Record<string, unknown>
  const parsedScores = parseDimensionScores(record.scores)
  if (!parsedScores) return null

  const contentTypes = parseContentTypes(record.content_types)
  const scores = applyContentTypeScoreCaps(contentTypes, parsedScores)

  const confidenceValue =
    typeof record.confidence === "number" ? record.confidence : Number(record.confidence)
  if (!Number.isFinite(confidenceValue)) return null

  const summary = typeof record.summary === "string" ? record.summary.trim() : ""
  const positiveReasons = parseStringArray(record.positive_reasons, 5)
  if (positiveReasons.length === 0) return null

  return {
    content_types: contentTypes,
    scores,
    quality_score: calculateQualityScore(scores),
    positive_reasons: positiveReasons,
    negative_reasons: parseStringArray(record.negative_reasons, 5),
    confidence: Math.min(1, Math.max(0, confidenceValue)),
    summary,
  }
}
