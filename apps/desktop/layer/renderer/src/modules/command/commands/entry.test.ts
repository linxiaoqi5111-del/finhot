import { describe, expect, test } from "vitest"

import { getNotInterestedIconClassName, getReadIconClassName } from "./entry"

describe("getNotInterestedIconClassName", () => {
  test("keeps the visible thumb down icon for the active not interested state", () => {
    expect(getNotInterestedIconClassName(true)).toBe("i-focal-thumb-down")
  })

  test("does not color the inactive icon", () => {
    expect(getNotInterestedIconClassName(false)).toBe("i-focal-thumb-down")
  })
})

describe("getReadIconClassName", () => {
  test("uses the list-check icon for the entry read toggle", () => {
    expect(getReadIconClassName()).toBe("i-focal-list-check")
  })
})
