import { afterEach, describe, expect, test, vi } from "vitest"

import { resolveLocalImageUrl } from "../local-image"

const { imageResolveMock } = vi.hoisted(() => ({
  imageResolveMock: vi.fn(),
}))

vi.mock("../client", () => ({
  ipcServices: {
    image: {
      resolve: imageResolveMock,
    },
  },
}))

describe("resolveLocalImageUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  test("returns origin url outside electron", async () => {
    vi.stubGlobal("window", { electron: undefined })

    await expect(resolveLocalImageUrl("https://example.com/a.png")).resolves.toBe(
      "https://example.com/a.png",
    )
  })

  test("uses electron image resolver when available", async () => {
    imageResolveMock.mockResolvedValue("file:///cached/a.png")
    vi.stubGlobal("window", {
      electron: {
        ipcRenderer: {},
      },
    })

    await expect(
      resolveLocalImageUrl("https://example.com/a.png", { kind: "media" }),
    ).resolves.toBe("file:///cached/a.png")
  })
})
