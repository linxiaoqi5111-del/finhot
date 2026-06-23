import type { BehaviorEventType } from "./behavior-events"
import { BEHAVIOR_EVENT_WEIGHTS, getBehaviorEventPolarity } from "./behavior-events"

export type InterestClusterPolarity = "positive" | "negative"

export interface InterestCluster {
  id: string
  polarity: InterestClusterPolarity
  centroid: number[]
  weight: number
  sample_count: number
  updated_at: string
}

export const INTEREST_CLUSTER_IDS = {
  positive: "cluster-positive",
  negative: "cluster-negative",
} as const

export const RANK_INTEREST_MAX = 0.55
export const RANK_POSITIVE_MATCH_THRESHOLD = 0.76
export const RANK_NEGATIVE_MATCH_THRESHOLD = 0.62

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0
  }

  let dot = 0
  let leftNorm = 0
  let rightNorm = 0

  for (const [index, leftValue] of left.entries()) {
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftNorm += leftValue * leftValue
    rightNorm += rightValue * rightValue
  }

  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

export function updateInterestCluster({
  cluster,
  vector,
  eventType,
}: {
  cluster: InterestCluster | null
  vector: number[]
  eventType: BehaviorEventType
}): InterestCluster {
  const polarity = getBehaviorEventPolarity(eventType)
  const behaviorWeight = Math.abs(BEHAVIOR_EVENT_WEIGHTS[eventType])
  const now = new Date().toISOString()

  if (!cluster) {
    return {
      id: polarity === "positive" ? INTEREST_CLUSTER_IDS.positive : INTEREST_CLUSTER_IDS.negative,
      polarity,
      centroid: [...vector],
      weight: behaviorWeight,
      sample_count: 1,
      updated_at: now,
    }
  }

  const nextWeight = cluster.weight + behaviorWeight
  const alpha = behaviorWeight / nextWeight
  const centroid = cluster.centroid.map((value, index) => {
    const nextValue = vector[index] ?? 0
    return value * (1 - alpha) + nextValue * alpha
  })

  return {
    ...cluster,
    centroid,
    weight: nextWeight,
    sample_count: cluster.sample_count + 1,
    updated_at: now,
  }
}

export interface InterestRankComponents {
  interest_component: number
  negative_interest_penalty: number
}

export function computeInterestComponents(
  embedding: number[] | null | undefined,
  clusters: InterestCluster[],
): InterestRankComponents {
  if (!embedding || embedding.length === 0 || clusters.length === 0) {
    return {
      interest_component: 0,
      negative_interest_penalty: 0,
    }
  }

  let bestPositiveContribution = 0
  let bestNegativePenalty = 0

  for (const cluster of clusters) {
    const similarity = cosineSimilarity(embedding, cluster.centroid)
    const normalizedWeight = Math.min(cluster.weight / 20, 1)

    if (cluster.polarity === "positive" && similarity >= RANK_POSITIVE_MATCH_THRESHOLD) {
      const contribution = similarity * normalizedWeight * RANK_INTEREST_MAX
      bestPositiveContribution = Math.max(bestPositiveContribution, contribution)
    }

    if (cluster.polarity === "negative" && similarity >= RANK_NEGATIVE_MATCH_THRESHOLD) {
      const penalty = similarity * normalizedWeight * 0.12
      bestNegativePenalty = Math.max(bestNegativePenalty, penalty)
    }
  }

  return {
    interest_component: Math.min(RANK_INTEREST_MAX, bestPositiveContribution),
    negative_interest_penalty: bestNegativePenalty,
  }
}
