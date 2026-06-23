import { describe, expect, test, vi } from "vitest"

import type { BizUIMessage } from "./types"

vi.mock("@follow/store/entry/getter", () => ({
  getEntry: vi.fn((entryId: string) =>
    entryId === "entry-1"
      ? {
          title: "Binding self-help notes",
          url: "https://example.com/entry-1",
          content: "<article><p>The article mentions aspirin and ibuprofen.</p></article>",
          readabilityContent: null,
        }
      : undefined,
  ),
}))

describe("toOpenAIChatMessages", () => {
  test("includes main entry content in local BYOK messages", async () => {
    const { toOpenAIChatMessages } = await import("./local-byok-context")
    const messages: BizUIMessage[] = [
      {
        id: "message-1",
        role: "user",
        createdAt: new Date("2026-06-14T00:00:00.000Z"),
        parts: [
          {
            type: "data-block",
            data: [
              {
                id: "mainEntry",
                type: "mainEntry",
                value: "entry-1",
              },
            ],
          },
          {
            type: "data-rich-text",
            data: {
              state: "{}",
              text: "How many drugs are mentioned here?",
            },
          },
        ],
      },
    ]

    expect(toOpenAIChatMessages(messages)).toEqual([
      {
        role: "user",
        content: expect.stringContaining("Title: Binding self-help notes"),
      },
    ])
    expect(toOpenAIChatMessages(messages)[0]?.content).toContain(
      "The article mentions aspirin and ibuprofen.",
    )
    expect(toOpenAIChatMessages(messages)[0]?.content).toContain(
      "How many drugs are mentioned here?",
    )
  })
})
