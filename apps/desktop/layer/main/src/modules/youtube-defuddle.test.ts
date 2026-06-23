import { describe, expect, it } from "vitest"

import { fetchYouTubeDefuddle } from "./youtube-defuddle"

describe("fetchYouTubeDefuddle", () => {
  it("returns null for non-YouTube URLs", async () => {
    await expect(fetchYouTubeDefuddle({ url: "https://example.com/article" })).resolves.toBeNull()
  })
})
