import { describe, expect, it } from "vitest"

import {
  computeInterestComponents,
  cosineSimilarity,
  INTEREST_CLUSTER_IDS,
  updateInterestCluster,
} from "./interest-profile"

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5)
  })

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5)
  })
})

describe("updateInterestCluster", () => {
  it("creates a new cluster when none exists", () => {
    const cluster = updateInterestCluster({
      cluster: null,
      vector: [1, 0],
      eventType: "favorite",
    })

    expect(cluster.id).toBe(INTEREST_CLUSTER_IDS.positive)
    expect(cluster.weight).toBe(6)
    expect(cluster.centroid).toEqual([1, 0])
  })

  it("merges vectors into an existing cluster", () => {
    const existing = updateInterestCluster({
      cluster: null,
      vector: [1, 0],
      eventType: "favorite",
    })

    const updated = updateInterestCluster({
      cluster: existing,
      vector: [0, 1],
      eventType: "read_complete",
    })

    expect(updated.sample_count).toBe(2)
    expect(updated.weight).toBe(10)
    expect(updated.centroid[0]).toBeGreaterThan(0)
    expect(updated.centroid[1]).toBeGreaterThan(0)
  })
})

describe("computeInterestComponents", () => {
  it("boosts rank when embedding matches positive cluster", () => {
    const cluster = updateInterestCluster({
      cluster: null,
      vector: [1, 0, 0],
      eventType: "favorite",
    })

    const result = computeInterestComponents([1, 0, 0], [cluster])
    expect(result.interest_component).toBeGreaterThan(0)
    expect(result.negative_interest_penalty).toBe(0)
  })

  it("applies penalty when embedding matches negative cluster", () => {
    const cluster = updateInterestCluster({
      cluster: null,
      vector: [1, 0, 0],
      eventType: "not_interested",
    })

    const result = computeInterestComponents([1, 0, 0], [cluster])
    expect(result.negative_interest_penalty).toBeGreaterThan(0)
  })
})
