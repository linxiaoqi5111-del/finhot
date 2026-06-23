import { describe, expect, test } from "vitest"

import type { EntryModel } from "../entry/types"
import {
  buildEmbeddingSourceText,
  hasEmbeddingEligibleText,
  hashEmbeddingSourceText,
  isEmbeddingStaleForEntry,
} from "./source-text"

const createEntry = (overrides: Partial<EntryModel> = {}): EntryModel =>
  ({
    id: "entry-1",
    guid: "guid-1",
    insertedAt: new Date("2026-01-01T00:00:00.000Z"),
    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  }) as EntryModel

describe("buildEmbeddingSourceText", () => {
  test("joins title, RSS description, and plain content text", () => {
    const text = buildEmbeddingSourceText(
      createEntry({
        title: "Plain <em>title</em>",
        description: "<p>Feed summary</p>",
        content: "<article><p>Body <b>HTML</b></p></article>",
      }),
    )

    expect(text).toBe("Plain title\n\nFeed summary\n\nBody HTML")
  })

  test("prefers readability content over feed content", () => {
    const text = buildEmbeddingSourceText(
      createEntry({
        title: "Title",
        content: "<p>Feed body</p>",
        readabilityContent: "<p>Full extracted body</p>",
      }),
    )

    expect(text).toBe("Title\n\nFull extracted body")
  })

  test("returns empty string when no eligible text exists", () => {
    expect(hasEmbeddingEligibleText(createEntry())).toBe(false)
    expect(buildEmbeddingSourceText(createEntry())).toBe("")
  })

  test("detects stale embeddings when source text changes", () => {
    const entry = createEntry({
      title: "Title",
      description: "Summary",
    })
    const sourceText = buildEmbeddingSourceText(entry)
    const sourceHash = hashEmbeddingSourceText(sourceText)

    expect(isEmbeddingStaleForEntry(entry, { sourceHash })).toBe(false)
    expect(
      isEmbeddingStaleForEntry(createEntry({ ...entry, title: "Changed title" }), { sourceHash }),
    ).toBe(true)
    expect(isEmbeddingStaleForEntry(entry, {})).toBe(true)
  })
})
