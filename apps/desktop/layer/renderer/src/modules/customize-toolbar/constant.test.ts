import { describe, expect, test } from "vitest"

import { COMMAND_ID } from "../command/commands/id"
import { DEFAULT_ACTION_ORDER, mergeToolbarActionOrder } from "./constant"

describe("DEFAULT_ACTION_ORDER", () => {
  test("uses the product default quick actions in order", () => {
    expect(DEFAULT_ACTION_ORDER.main).toEqual([
      COMMAND_ID.global.quickSearch,
      COMMAND_ID.entry.read,
      COMMAND_ID.entry.star,
      COMMAND_ID.entry.notInterested,
      COMMAND_ID.entry.readability,
      COMMAND_ID.entry.toggleAITranslation,
      COMMAND_ID.entry.share,
    ])
  })

  test("inserts new default quick actions according to the default order", () => {
    const merged = mergeToolbarActionOrder({
      main: [
        COMMAND_ID.entry.read,
        COMMAND_ID.entry.star,
        COMMAND_ID.entry.notInterested,
        COMMAND_ID.entry.readability,
        COMMAND_ID.entry.toggleAITranslation,
        COMMAND_ID.entry.share,
      ],
      more: [],
    })

    expect(merged.main).toEqual(DEFAULT_ACTION_ORDER.main)
  })
})
