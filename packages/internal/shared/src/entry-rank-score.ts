import type { EntryQualityScoreRecord } from "./entry-quality-score"
import type { InterestCluster } from "./interest-profile"
import { computeInterestComponents } from "./interest-profile"

export type EntryRankContext = "cold_start" | "interest"

export type EntryRankReasonType =
  | "quality"
  | "freshness"
  | "state"
  | "interest"
  | "negative_interest"
  | "fallback"

export interface EntryRankReason {
  type: EntryRankReasonType
  label: string
  impact: "positive" | "negative" | "neutral"
}

export interface EntryRankComponents {
  quality_component: number
  freshness_component: number
  interest_component: number
  negative_interest_penalty: number
  base_score: number
}

export interface EntryRankRecord {
  context: EntryRankContext
  components: EntryRankComponents
  reasons: EntryRankReason[]
  computed_at: string
}

export interface RankComposerInput {
  publishedAt: Date
  insertedAt?: Date | null
  qualityRecord: EntryQualityScoreRecord | null
  now?: Date
}

export interface RankInterestComposerInput extends RankComposerInput {
  embedding?: number[] | null
  clusters?: InterestCluster[]
}

export interface EntryStateRankInput {
  read: boolean
  starred: boolean
}

export type EntryTimelineSortMode = "latest" | "recommended"

export const RANK_QUALITY_MAX = 0.35
export const RANK_FRESHNESS_MAX = 0.35
export const RANK_FRESHNESS_HALF_LIFE_HOURS = 36

export const RANK_STATE_UNREAD = 0.06
export const RANK_STATE_STARRED = 0.04
export const RANK_STATE_READ = -0.08

export const RECOMMENDED_MIN_QUALITY_SCORE = 50
export const RECOMMENDED_UNSCORED_GRACE_HOURS = 24

const MS_PER_HOUR = 60 * 60 * 1000

export function clampRankScore(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

export function getEntryStateScore({ read, starred }: EntryStateRankInput): number {
  if (starred) return RANK_STATE_STARRED
  if (!read) return RANK_STATE_UNREAD
  return RANK_STATE_READ
}

export function getEntryFinalRankScore(record: EntryRankRecord, stateScore: number): number {
  return clampRankScore(record.components.base_score + stateScore)
}

function getStartOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function isBeforeLocalDay(date: Date, now: Date): boolean {
  return date.getTime() < getStartOfLocalDay(now).getTime()
}

function computeFreshnessComponent(referenceDate: Date, now: Date): number {
  const ageHours = Math.max(0, (now.getTime() - referenceDate.getTime()) / MS_PER_HOUR)
  return Math.exp(-ageHours / RANK_FRESHNESS_HALF_LIFE_HOURS) * RANK_FRESHNESS_MAX
}

function computeQualityComponent(qualityRecord: EntryQualityScoreRecord | null): number {
  if (!qualityRecord) return 0

  const normalized = qualityRecord.quality_score / 100
  const confidence = clampRankScore(qualityRecord.confidence)
  return normalized * confidence * RANK_QUALITY_MAX
}

function buildReasons(
  qualityRecord: EntryQualityScoreRecord | null,
  qualityComponent: number,
  freshnessComponent: number,
): EntryRankReason[] {
  const reasons: EntryRankReason[] = []

  if (qualityRecord && qualityComponent > 0) {
    reasons.push({
      type: "quality",
      label: `Quality score ${qualityRecord.quality_score}`,
      impact: "positive",
    })
  } else {
    reasons.push({
      type: "fallback",
      label: "Quality score pending",
      impact: "neutral",
    })
  }

  if (freshnessComponent > 0) {
    reasons.push({
      type: "freshness",
      label: "Recency boost",
      impact: "positive",
    })
  }

  return reasons.slice(0, 5)
}

function buildInterestReasons(
  interestComponent: number,
  negativePenalty: number,
): EntryRankReason[] {
  const reasons: EntryRankReason[] = []

  if (interestComponent > 0) {
    reasons.push({
      type: "interest",
      label: "Interest match",
      impact: "positive",
    })
  }

  if (negativePenalty > 0) {
    reasons.push({
      type: "negative_interest",
      label: "Negative interest match",
      impact: "negative",
    })
  }

  return reasons
}

export function composeRankBase(input: RankComposerInput): EntryRankRecord {
  const now = input.now ?? new Date()
  const referenceDate = input.publishedAt ?? input.insertedAt ?? now

  const qualityComponent = computeQualityComponent(input.qualityRecord)
  const freshnessComponent = computeFreshnessComponent(referenceDate, now)
  const baseScore = clampRankScore(qualityComponent + freshnessComponent)

  return {
    context: "cold_start",
    components: {
      quality_component: qualityComponent,
      freshness_component: freshnessComponent,
      interest_component: 0,
      negative_interest_penalty: 0,
      base_score: baseScore,
    },
    reasons: buildReasons(input.qualityRecord, qualityComponent, freshnessComponent),
    computed_at: now.toISOString(),
  }
}

export function composeRankWithInterest(input: RankInterestComposerInput): EntryRankRecord {
  const base = composeRankBase(input)
  const { interest_component, negative_interest_penalty } = computeInterestComponents(
    input.embedding,
    input.clusters ?? [],
  )

  const baseScore = clampRankScore(
    base.components.quality_component +
      base.components.freshness_component +
      interest_component -
      negative_interest_penalty,
  )

  const hasInterestSignal =
    Boolean(input.embedding && input.embedding.length > 0) &&
    (interest_component > 0 || negative_interest_penalty > 0 || (input.clusters?.length ?? 0) > 0)

  return {
    context: hasInterestSignal ? "interest" : base.context,
    components: {
      ...base.components,
      interest_component,
      negative_interest_penalty,
      base_score: baseScore,
    },
    reasons: [
      ...base.reasons,
      ...buildInterestReasons(interest_component, negative_interest_penalty),
    ].slice(0, 5),
    computed_at: base.computed_at,
  }
}

export interface SortEntryIdsByRankInput {
  entryIds: string[]
  getBaseRank: (entryId: string) => EntryRankRecord | undefined
  getPublishedAt: (entryId: string) => Date | undefined
  getEntryState: (entryId: string) => EntryStateRankInput | undefined
}

export function sortEntryIdsByRank({
  entryIds,
  getBaseRank,
  getPublishedAt,
  getEntryState,
}: SortEntryIdsByRankInput): string[] {
  return [...entryIds].sort((leftId, rightId) => {
    const leftRank = getBaseRank(leftId)
    const rightRank = getBaseRank(rightId)

    const leftState = getEntryState(leftId) ?? { read: false, starred: false }
    const rightState = getEntryState(rightId) ?? { read: false, starred: false }

    const leftFinal = leftRank
      ? getEntryFinalRankScore(leftRank, getEntryStateScore(leftState))
      : getEntryStateScore(leftState)
    const rightFinal = rightRank
      ? getEntryFinalRankScore(rightRank, getEntryStateScore(rightState))
      : getEntryStateScore(rightState)

    if (rightFinal !== leftFinal) {
      return rightFinal - leftFinal
    }

    const leftPublishedAt = getPublishedAt(leftId)?.getTime() ?? 0
    const rightPublishedAt = getPublishedAt(rightId)?.getTime() ?? 0
    if (rightPublishedAt !== leftPublishedAt) {
      return rightPublishedAt - leftPublishedAt
    }

    return leftId.localeCompare(rightId)
  })
}

export interface RecommendedEntryCandidateInput {
  entryIds: string[]
  now?: Date
  getPublishedAt: (entryId: string) => Date | undefined
  getInsertedAt?: (entryId: string) => Date | undefined
  getQualityRecord: (entryId: string) => EntryQualityScoreRecord | null | undefined
  getEntryState: (entryId: string) => EntryStateRankInput | undefined
  getReadCompletedAt?: (entryId: string) => Date | undefined
  getStarredAt?: (entryId: string) => Date | undefined
  getNotInterestedAt?: (entryId: string) => Date | undefined
}

export function isRecommendedEntryCandidate({
  entryId,
  now = new Date(),
  getPublishedAt,
  getInsertedAt,
  getQualityRecord,
  getEntryState,
  getReadCompletedAt,
  getStarredAt,
  getNotInterestedAt,
}: Omit<RecommendedEntryCandidateInput, "entryIds"> & { entryId: string }): boolean {
  if (getNotInterestedAt?.(entryId)) return false

  const state = getEntryState(entryId) ?? { read: false, starred: false }
  const readCompletedAt = getReadCompletedAt?.(entryId)
  if (state.read && readCompletedAt && isBeforeLocalDay(readCompletedAt, now)) return false

  const starredAt = getStarredAt?.(entryId)
  if (state.starred && starredAt && isBeforeLocalDay(starredAt, now)) return false

  const qualityRecord = getQualityRecord(entryId)
  if (qualityRecord) {
    return qualityRecord.quality_score >= RECOMMENDED_MIN_QUALITY_SCORE
  }

  const referenceDate = getPublishedAt(entryId) ?? getInsertedAt?.(entryId)
  if (!referenceDate) return false

  const ageHours = Math.max(0, (now.getTime() - referenceDate.getTime()) / MS_PER_HOUR)
  return ageHours <= RECOMMENDED_UNSCORED_GRACE_HOURS
}

export function filterRecommendedEntryIds({
  entryIds,
  ...input
}: RecommendedEntryCandidateInput): string[] {
  return entryIds.filter((entryId) => isRecommendedEntryCandidate({ ...input, entryId }))
}
