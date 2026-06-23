export const ENTRY_QUALITY_CONTENT_TYPES = [
  "Workflow",
  "CaseStudy",
  "Tutorial",
  "OpenSourceRelease",
  "Opinion",
  "Research",
  "ProductUpdate",
  "News",
] as const

export type EntryQualityContentType = (typeof ENTRY_QUALITY_CONTENT_TYPES)[number]

export type EntryQualityDimensionScores = {
  information_gain: number
  depth: number
  evidence: number
  actionability: number
  originality: number
  signal_density: number
}

export type EntryQualityScoreRecord = {
  content_types: Partial<Record<EntryQualityContentType, number>>
  scores: EntryQualityDimensionScores
  quality_score: number
  positive_reasons: string[]
  negative_reasons: string[]
  confidence: number
  summary: string
}

export function calculateQualityScore(scores: EntryQualityDimensionScores): number {
  const raw =
    scores.information_gain * 0.2 +
    scores.depth * 0.25 +
    scores.evidence * 0.15 +
    scores.actionability * 0.15 +
    scores.originality * 0.15 +
    scores.signal_density * 0.1

  return Math.round((raw / 5) * 100)
}

export function getQualityScoreTier(score: number): "high" | "medium" | "low" | "ignore" {
  if (score >= 80) return "high"
  if (score >= 60) return "medium"
  if (score >= 40) return "low"
  return "ignore"
}
