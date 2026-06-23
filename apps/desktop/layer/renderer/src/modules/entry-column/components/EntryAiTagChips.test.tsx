/* eslint-disable @eslint-react/hooks-extra/ensure-custom-hooks-using-other-hooks, @eslint-react/hooks-extra/no-unnecessary-use-prefix -- mocked store hooks must keep production export names */
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"

import { EntryAiTagChips } from "./EntryAiTagChips"

vi.mock("@follow/shared/constants", () => ({
  LOCAL_RSS_MODE: true,
}))

vi.mock("@follow/store/entry-tags/hooks", () => ({
  useEntryAiTags: () => [{ label: "AI" }],
  useEntryContentType: () => ({ label: "News" }),
}))

describe("EntryAiTagChips", () => {
  test("uses symmetric vertical margins between title and description", () => {
    const markup = renderToStaticMarkup(<EntryAiTagChips entryId="entry-id" />)

    expect(markup).toContain("my-0.5")
    expect(markup).not.toContain("mt-1")
  })
})
