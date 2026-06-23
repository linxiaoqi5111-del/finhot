import { describe, expect, test } from "vitest"

import { checkFeatureEnabled } from "./useFeature"

describe("checkFeatureEnabled", () => {
  test("enables AI locally without remote server configs", () => {
    expect(checkFeatureEnabled("ai", {}, undefined, true)).toBe(true)
  })

  test("keeps non-local AI gated by server configs", () => {
    expect(checkFeatureEnabled("ai", {}, undefined, false)).toBe(false)
  })
})
