import { describe, expect, test, vi } from "vitest"

import { getListItemLineClampClassNames } from "./list-item-line-clamp"

vi.mock("@follow/utils/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@follow/utils/utils")>()
  return {
    ...actual,
    isSafari: () => false,
  }
})

describe("list item line clamp classes", () => {
  test("limits regular titles to two lines while preserving description space", () => {
    const lineClamp = getListItemLineClampClassNames({
      bilingual: false,
      entryDescription: "Description",
      entryTitle: "A very long title",
      isSummary: false,
      simple: false,
      translationDescription: undefined,
    })

    expect(lineClamp.title).toBe("line-clamp-2")
    expect(lineClamp.global).toBe("line-clamp-[4]")
  })

  test("limits bilingual titles to two lines", () => {
    const lineClamp = getListItemLineClampClassNames({
      bilingual: true,
      entryDescription: "Description",
      entryTitle: "A very long title",
      isSummary: false,
      simple: false,
      translationDescription: undefined,
    })

    expect(lineClamp.title).toBe("line-clamp-2")
    expect(lineClamp.global).toBe("line-clamp-[4]")
  })
})
