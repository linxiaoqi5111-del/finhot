import { describe, expect, test } from "vitest"

import { isRemoteSettingSyncEnabled, settingSyncQueue } from "./sync-queue"

describe("local setting sync queue", () => {
  test("disables remote setting sync", () => {
    expect(isRemoteSettingSyncEnabled()).toBe(false)
  })

  test("keeps queue empty for local-only operations", async () => {
    await settingSyncQueue.init()
    await settingSyncQueue.enqueue("general", { language: "en" })
    await settingSyncQueue.replaceRemote("general")
    await settingSyncQueue.syncLocal()

    expect(settingSyncQueue.queue).toEqual([])
  })
})
