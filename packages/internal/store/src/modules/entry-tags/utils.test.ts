import { describe, expect, test } from "vitest"

import { validateTagAssignments } from "./utils"

describe("validateTagAssignments", () => {
  test("keeps only candidate labels and max 3 tags", () => {
    const result = validateTagAssignments({
      tags: [
        { label: "AI", confidence: 0.9, reason: "Discusses LLM products" },
        { label: "Invalid", confidence: 0.8, reason: "Should be dropped" },
        { label: "产品", confidence: 0.7, reason: "Product launch" },
        { label: "编程", confidence: 0.6, reason: "Code tutorial" },
        { label: "设计", confidence: 0.5, reason: "UI patterns" },
      ],
    })

    expect(result).toHaveLength(3)
    expect(result.map((tag) => tag.label)).toEqual(["AI", "产品", "编程"])
    expect(result[0]?.confidence).toBe(0.9)
  })

  test("deduplicates labels and clamps confidence", () => {
    const result = validateTagAssignments({
      tags: [
        { label: "Agent", confidence: 1.4, reason: "Agent workflow" },
        { label: "Agent", confidence: 0.2, reason: "Duplicate" },
      ],
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.confidence).toBe(1)
  })
})
