import { describe, expect, it } from "vitest"

import { FOCAL_BRAND_ACCENT_COLOR, getAccentColorValue } from "./constants"

describe("accent color settings", () => {
  it("maps legacy and custom accent choices to the FinHot brand color", () => {
    expect(getAccentColorValue("orange")).toEqual(FOCAL_BRAND_ACCENT_COLOR)
    expect(getAccentColorValue("blue")).toEqual(FOCAL_BRAND_ACCENT_COLOR)
    expect(getAccentColorValue("#ff00aa")).toEqual(FOCAL_BRAND_ACCENT_COLOR)
  })
})
