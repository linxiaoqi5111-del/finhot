import { describe, expect, test } from "vitest"

import { removeBehaviorEvents } from "./store"

describe("removeBehaviorEvents", () => {
  test("removes only matching events for the entry and event type", () => {
    const events = [
      {
        id: "target-not-interested",
        entryId: "entry-1",
        eventType: "not_interested" as const,
        createdAt: "2026-06-15T00:00:00.000Z",
      },
      {
        id: "other-entry-not-interested",
        entryId: "entry-2",
        eventType: "not_interested" as const,
        createdAt: "2026-06-15T00:00:00.000Z",
      },
      {
        id: "target-favorite",
        entryId: "entry-1",
        eventType: "favorite" as const,
        createdAt: "2026-06-15T00:00:00.000Z",
      },
    ]

    expect(removeBehaviorEvents(events, "entry-1", "not_interested")).toEqual([
      events[1],
      events[2],
    ])
  })
})
