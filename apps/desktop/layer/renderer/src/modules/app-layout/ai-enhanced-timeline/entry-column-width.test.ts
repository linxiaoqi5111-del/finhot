import { defaultUISettings } from "@follow/shared/settings/defaults"
import { describe, expect, test } from "vitest"

import {
  resolveDefaultEntryColumnWidth,
  resolveInitialEntryColumnWidth,
  resolveResetEntryColumnWidth,
} from "./entry-column-width"

describe("entry column responsive width", () => {
  test("uses a responsive ratio for the untouched default width", () => {
    expect(resolveInitialEntryColumnWidth(defaultUISettings.entryColWidth, 1600, 296)).toBe(496)
  })

  test("keeps user resized width instead of recalculating the ratio", () => {
    expect(resolveInitialEntryColumnWidth(440, 1600, 296)).toBe(440)
  })

  test("clamps responsive default width for readability", () => {
    expect(resolveDefaultEntryColumnWidth(900, 296)).toBe(360)
    expect(resolveDefaultEntryColumnWidth(2200, 296)).toBe(560)
  })

  test("resets to the current responsive default width", () => {
    expect(resolveResetEntryColumnWidth(1600, 296)).toBe(496)
  })
})
