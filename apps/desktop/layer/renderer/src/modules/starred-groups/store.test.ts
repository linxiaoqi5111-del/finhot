import { describe, expect, it } from "vitest"

import { doesEntryMatchStarredGroupFilter } from "./store"

describe("starred group visibility", () => {
  it("does not filter starred entries while starred groups are hidden", () => {
    expect(
      doesEntryMatchStarredGroupFilter({
        entryId: "entry-1",
        selectedGroupId: "group-a",
        assignments: {},
      }),
    ).toBe(true)
  })
})
