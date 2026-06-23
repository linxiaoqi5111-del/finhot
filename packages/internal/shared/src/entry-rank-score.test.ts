import { describe, expect, it } from "vitest"

import type { EntryQualityScoreRecord } from "./entry-quality-score"
import {
  composeRankBase,
  composeRankWithInterest,
  filterRecommendedEntryIds,
  getEntryFinalRankScore,
  getEntryStateScore,
  sortEntryIdsByRank,
} from "./entry-rank-score"
import { updateInterestCluster } from "./interest-profile"

const qualityRecord = (score: number, confidence = 1): EntryQualityScoreRecord => ({
  content_types: { Tutorial: 1 },
  scores: {
    information_gain: 4,
    depth: 4,
    evidence: 4,
    actionability: 4,
    originality: 4,
    signal_density: 4,
  },
  quality_score: score,
  positive_reasons: [],
  negative_reasons: [],
  confidence,
  summary: "Test summary",
})

describe("composeRankBase", () => {
  it("weights quality by confidence", () => {
    const now = new Date("2026-06-07T12:00:00.000Z")
    const record = composeRankBase({
      publishedAt: now,
      qualityRecord: qualityRecord(80, 0.5),
      now,
    })

    expect(record.components.quality_component).toBeCloseTo(0.14, 5)
    expect(record.components.freshness_component).toBeCloseTo(0.35, 5)
    expect(record.components.base_score).toBeCloseTo(0.49, 5)
    expect(record.context).toBe("cold_start")
  })

  it("falls back to freshness when quality is missing", () => {
    const now = new Date("2026-06-07T12:00:00.000Z")
    const record = composeRankBase({
      publishedAt: new Date("2026-06-06T12:00:00.000Z"),
      qualityRecord: null,
      now,
    })

    expect(record.components.quality_component).toBe(0)
    expect(record.components.freshness_component).toBeGreaterThan(0)
    expect(record.reasons.some((reason) => reason.type === "fallback")).toBe(true)
  })
})

describe("composeRankWithInterest", () => {
  it("adds interest component when embedding matches positive cluster", () => {
    const now = new Date("2026-06-07T12:00:00.000Z")
    const cluster = updateInterestCluster({
      cluster: null,
      vector: [1, 0, 0],
      eventType: "favorite",
    })

    const record = composeRankWithInterest({
      publishedAt: now,
      qualityRecord: qualityRecord(80),
      embedding: [1, 0, 0],
      clusters: [cluster],
      now,
    })

    expect(record.context).toBe("interest")
    expect(record.components.interest_component).toBeGreaterThan(0)
    expect(record.components.base_score).toBeGreaterThan(record.components.quality_component)
  })
})

describe("getEntryStateScore", () => {
  it("prioritizes unread and starred states", () => {
    expect(getEntryStateScore({ read: false, starred: false })).toBe(0.06)
    expect(getEntryStateScore({ read: true, starred: true })).toBe(0.04)
    expect(getEntryStateScore({ read: true, starred: false })).toBe(-0.08)
  })
})

describe("sortEntryIdsByRank", () => {
  it("sorts by final rank and publishedAt tie-break", () => {
    const now = new Date("2026-06-07T12:00:00.000Z")
    const highQuality = composeRankBase({
      publishedAt: new Date("2026-06-06T12:00:00.000Z"),
      qualityRecord: qualityRecord(90),
      now,
    })
    const lowQuality = composeRankBase({
      publishedAt: new Date("2026-06-07T11:00:00.000Z"),
      qualityRecord: qualityRecord(40),
      now,
    })

    const sorted = sortEntryIdsByRank({
      entryIds: ["b", "a"],
      getBaseRank: (entryId) => (entryId === "a" ? highQuality : lowQuality),
      getPublishedAt: (entryId) =>
        entryId === "a"
          ? new Date("2026-06-06T12:00:00.000Z")
          : new Date("2026-06-07T11:00:00.000Z"),
      getEntryState: () => ({ read: false, starred: false }),
    })

    expect(sorted).toEqual(["a", "b"])
  })

  it("applies live read state during sort", () => {
    const now = new Date("2026-06-07T12:00:00.000Z")
    const record = composeRankBase({
      publishedAt: now,
      qualityRecord: qualityRecord(70),
      now,
    })

    const sorted = sortEntryIdsByRank({
      entryIds: ["read-entry", "unread-entry"],
      getBaseRank: () => record,
      getPublishedAt: () => now,
      getEntryState: (entryId) => ({
        read: entryId === "read-entry",
        starred: false,
      }),
    })

    expect(sorted).toEqual(["unread-entry", "read-entry"])
    expect(
      getEntryFinalRankScore(record, getEntryStateScore({ read: true, starred: false })),
    ).toBeLessThan(
      getEntryFinalRankScore(record, getEntryStateScore({ read: false, starred: false })),
    )
  })
})

describe("filterRecommendedEntryIds", () => {
  const now = new Date("2026-06-08T10:00:00.000Z")

  it("filters entries with quality score below the recommendation threshold", () => {
    const filtered = filterRecommendedEntryIds({
      entryIds: ["low", "high"],
      now,
      getPublishedAt: () => now,
      getQualityRecord: (entryId) => qualityRecord(entryId === "low" ? 49 : 50),
      getEntryState: () => ({ read: false, starred: false }),
    })

    expect(filtered).toEqual(["high"])
  })

  it("keeps unscored fresh entries during the grace period", () => {
    const filtered = filterRecommendedEntryIds({
      entryIds: ["fresh", "stale"],
      now,
      getPublishedAt: (entryId) =>
        entryId === "fresh"
          ? new Date("2026-06-07T11:00:00.000Z")
          : new Date("2026-06-07T09:00:00.000Z"),
      getQualityRecord: () => null,
      getEntryState: () => ({ read: false, starred: false }),
    })

    expect(filtered).toEqual(["fresh"])
  })

  it("removes read and starred entries after the day they were handled", () => {
    const filtered = filterRecommendedEntryIds({
      entryIds: ["read-yesterday", "starred-yesterday", "read-today", "starred-today"],
      now,
      getPublishedAt: () => now,
      getQualityRecord: () => qualityRecord(80),
      getEntryState: (entryId) => ({
        read: entryId.startsWith("read"),
        starred: entryId.startsWith("starred"),
      }),
      getReadCompletedAt: (entryId) =>
        entryId === "read-yesterday"
          ? new Date("2026-06-07T10:00:00.000Z")
          : entryId === "read-today"
            ? new Date("2026-06-08T01:00:00.000Z")
            : undefined,
      getStarredAt: (entryId) =>
        entryId === "starred-yesterday"
          ? new Date("2026-06-07T10:00:00.000Z")
          : entryId === "starred-today"
            ? new Date("2026-06-08T01:00:00.000Z")
            : undefined,
    })

    expect(filtered).toEqual(["read-today", "starred-today"])
  })

  it("removes entries explicitly marked not interested", () => {
    const filtered = filterRecommendedEntryIds({
      entryIds: ["dismissed", "candidate"],
      now,
      getPublishedAt: () => now,
      getQualityRecord: () => qualityRecord(80),
      getEntryState: () => ({ read: false, starred: false }),
      getNotInterestedAt: (entryId) =>
        entryId === "dismissed" ? new Date("2026-06-08T09:00:00.000Z") : undefined,
    })

    expect(filtered).toEqual(["candidate"])
  })
})
