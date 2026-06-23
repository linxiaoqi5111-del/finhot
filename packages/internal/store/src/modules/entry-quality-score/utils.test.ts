import { describe, expect, it } from "vitest"

import { applyContentTypeScoreCaps, validateQualityScoreResult } from "./utils"

describe("applyContentTypeScoreCaps", () => {
  it("caps inflated news digest scores", () => {
    const scores = applyContentTypeScoreCaps(
      { News: 0.85, ProductUpdate: 0.15 },
      {
        information_gain: 4,
        depth: 2,
        evidence: 2,
        actionability: 3,
        originality: 2,
        signal_density: 5,
      },
    )

    expect(scores).toEqual({
      information_gain: 3,
      depth: 2,
      evidence: 2,
      actionability: 1,
      originality: 2,
      signal_density: 5,
    })
  })

  it("caps product announcement actionability when no tutorial content is present", () => {
    const scores = applyContentTypeScoreCaps(
      { ProductUpdate: 0.7, News: 0.2, Research: 0.1 },
      {
        information_gain: 4,
        depth: 4,
        evidence: 3,
        actionability: 5,
        originality: 3,
        signal_density: 4,
      },
    )

    expect(scores).toEqual({
      information_gain: 4,
      depth: 2,
      evidence: 3,
      actionability: 1,
      originality: 3,
      signal_density: 4,
    })
  })

  it("does not cap tutorial scores", () => {
    const input = {
      information_gain: 4,
      depth: 4,
      evidence: 3,
      actionability: 5,
      originality: 3,
      signal_density: 4,
    }

    expect(applyContentTypeScoreCaps({ Tutorial: 0.6, Workflow: 0.4 }, input)).toEqual(input)
  })
})

describe("validateQualityScoreResult", () => {
  it("accepts valid AI output and computes quality score", () => {
    const result = validateQualityScoreResult({
      content_types: {
        Tutorial: 0.6,
        Workflow: 0.4,
      },
      scores: {
        information_gain: 4,
        depth: 4,
        evidence: 3,
        actionability: 5,
        originality: 3,
        signal_density: 4,
      },
      positive_reasons: ["Contains step-by-step guidance."],
      negative_reasons: ["Limited quantitative evidence."],
      confidence: 0.9,
      summary: "A practical workflow tutorial.",
    })

    expect(result).not.toBeNull()
    expect(result?.quality_score).toBe(77)
  })

  it("applies news caps before computing quality score", () => {
    const result = validateQualityScoreResult({
      content_types: {
        News: 0.85,
        ProductUpdate: 0.15,
      },
      scores: {
        information_gain: 4,
        depth: 2,
        evidence: 2,
        actionability: 3,
        originality: 2,
        signal_density: 5,
      },
      positive_reasons: ["High signal density."],
      negative_reasons: ["Mostly third-party summaries."],
      confidence: 0.88,
      summary: "A daily AI news digest.",
    })

    expect(result).not.toBeNull()
    expect(result?.scores.actionability).toBe(1)
    expect(result?.scores.information_gain).toBe(3)
    expect(result?.quality_score).toBe(47)
  })

  it("rejects invalid dimension scores", () => {
    const result = validateQualityScoreResult({
      content_types: { News: 1 },
      scores: {
        information_gain: 4,
        depth: "invalid",
      },
      positive_reasons: ["Some reason"],
      negative_reasons: [],
      confidence: 0.8,
      summary: "Summary",
    })

    expect(result).toBeNull()
  })
})
