import { describe, expect, it } from "vitest"

import { getTopicStatus, isSameSelector, matchEntryBySelector } from "./selector"
import type { MyTopic } from "./types"

describe("matchEntryBySelector", () => {
  it("matches aiTag when the entry carries the tag", () => {
    expect(
      matchEntryBySelector({ type: "aiTag", label: "AI" }, { title: "x" }, [{ label: "AI" }]),
    ).toBe(true)
  })

  it("does not match aiTag when the tag is absent", () => {
    expect(
      matchEntryBySelector({ type: "aiTag", label: "AI" }, { title: "x" }, [{ label: "产品" }]),
    ).toBe(false)
    expect(matchEntryBySelector({ type: "aiTag", label: "AI" }, { title: "x" })).toBe(false)
  })

  it("matches keyword case-insensitively on the title", () => {
    expect(
      matchEntryBySelector(
        { type: "keyword", query: "claude" },
        { title: "New Claude release" },
        [],
      ),
    ).toBe(true)
    expect(
      matchEntryBySelector({ type: "keyword", query: "  Claude  " }, { title: "claude code" }, []),
    ).toBe(true)
  })

  it("does not match keyword when title lacks the query or query is empty", () => {
    expect(matchEntryBySelector({ type: "keyword", query: "gpt" }, { title: "claude" }, [])).toBe(
      false,
    )
    expect(matchEntryBySelector({ type: "keyword", query: "   " }, { title: "anything" }, [])).toBe(
      false,
    )
    expect(matchEntryBySelector({ type: "keyword", query: "gpt" }, { title: null }, [])).toBe(false)
  })
})

describe("getTopicStatus", () => {
  const base: MyTopic = {
    id: "t",
    name: "t",
    selector: { type: "aiTag", label: "AI" },
    pinned: false,
    createdAt: 0,
    lastOpenedAt: 0,
  }
  const window = 1000

  it("is active when opened within the window", () => {
    expect(getTopicStatus({ ...base, lastOpenedAt: 600 }, 1000, window)).toBe("active")
  })

  it("is dormant when opened outside the window", () => {
    expect(getTopicStatus({ ...base, lastOpenedAt: 0 }, 2000, window)).toBe("dormant")
  })

  it("is always active when pinned", () => {
    expect(getTopicStatus({ ...base, pinned: true, lastOpenedAt: 0 }, 999_999, window)).toBe(
      "active",
    )
  })
})

describe("isSameSelector", () => {
  it("compares aiTag by label and keyword by normalized query", () => {
    expect(isSameSelector({ type: "aiTag", label: "AI" }, { type: "aiTag", label: "AI" })).toBe(
      true,
    )
    expect(isSameSelector({ type: "aiTag", label: "AI" }, { type: "aiTag", label: "产品" })).toBe(
      false,
    )
    expect(
      isSameSelector({ type: "keyword", query: "GPT " }, { type: "keyword", query: "gpt" }),
    ).toBe(true)
    expect(isSameSelector({ type: "aiTag", label: "AI" }, { type: "keyword", query: "AI" })).toBe(
      false,
    )
  })
})
