import { beforeEach, describe, expect, it, vi } from "vitest"

const getEntryMock = vi.fn()
const readabilityMock = vi.fn()
const youtubeDefuddleMock = vi.fn()

vi.mock("@follow/shared/constants", () => ({
  LOCAL_RSS_MODE: true,
}))

vi.mock("@follow/store/entry/getter", () => ({
  getEntry: getEntryMock,
}))

vi.mock("@follow/utils/url-for-video", () => ({
  isYouTubeWatchUrl: (url: string) => /youtube\.com\/watch\?v=/.test(url),
}))

vi.mock("~/lib/client", () => ({
  ipcServices: {
    reader: {
      readability: readabilityMock,
      youtubeDefuddle: youtubeDefuddleMock,
    },
  },
}))

describe("fetchEntryReadabilityContentFromSource", () => {
  beforeEach(() => {
    getEntryMock.mockReset()
    readabilityMock.mockReset()
    youtubeDefuddleMock.mockReset()
  })

  it("uses Electron reader readability result before falling back to RSS item content", async () => {
    getEntryMock.mockReturnValue({
      content: "RSS summary only",
      description: "RSS description",
    })
    readabilityMock.mockResolvedValue({
      content: "<article>Full article from source page</article>",
    })

    const { fetchEntryReadabilityContentFromSource } = await import("./readability-content")

    await expect(
      fetchEntryReadabilityContentFromSource({
        id: "entry-1",
        url: "https://example.com/post",
      }),
    ).resolves.toBe("<article>Full article from source page</article>")
    expect(readabilityMock).toHaveBeenCalledWith({ url: "https://example.com/post" })
  })

  it("falls back to RSS item content when reader readability has no content", async () => {
    getEntryMock.mockReturnValue({
      content: "RSS summary only",
      description: "RSS description",
    })
    readabilityMock.mockResolvedValue(null)

    const { fetchEntryReadabilityContentFromSource } = await import("./readability-content")

    await expect(
      fetchEntryReadabilityContentFromSource({
        id: "entry-1",
        url: "https://example.com/post",
      }),
    ).resolves.toBe("RSS summary only")
  })

  it("uses YouTube Defuddle transcript before readability for YouTube URLs", async () => {
    youtubeDefuddleMock.mockResolvedValue({
      content: "## Transcript\n\n**0:01** Hello",
      title: "Video title",
    })

    const { fetchEntryReadabilityContentFromSource } = await import("./readability-content")

    await expect(
      fetchEntryReadabilityContentFromSource({
        id: "entry-1",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
    ).resolves.toBe("## Transcript\n\n**0:01** Hello")
    expect(youtubeDefuddleMock).toHaveBeenCalledWith({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    })
    expect(readabilityMock).not.toHaveBeenCalled()
  })

  it("falls back to RSS item content when reader readability fails", async () => {
    getEntryMock.mockReturnValue({
      content: "RSS summary only",
      description: "RSS description",
    })
    readabilityMock.mockRejectedValue(new Error("Reader failed"))

    const { fetchEntryReadabilityContentFromSource } = await import("./readability-content")

    await expect(
      fetchEntryReadabilityContentFromSource({
        id: "entry-1",
        url: "https://example.com/post",
      }),
    ).resolves.toBe("RSS summary only")
  })
})
