import type { IpcContext } from "electron-ipc-decorator"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RssService } from "./rss"

vi.mock("electron-ipc-decorator", () => ({
  IpcMethod: () => (_target: unknown, _propertyKey: string, descriptor: PropertyDescriptor) =>
    descriptor,
  IpcService: class {},
}))

describe("RssService", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("uses permalink guid as entry URL when RSS item has no link element", async () => {
    const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Hugging Face Blog</title>
          <link>https://huggingface.co/blog</link>
          <description>Blog posts</description>
          <item>
            <title>Post without link</title>
            <guid isPermaLink="true">https://huggingface.co/blog/example-post</guid>
            <pubDate>Fri, 05 Jun 2026 00:00:00 GMT</pubDate>
            <description><![CDATA[Short summary]]></description>
          </item>
        </channel>
      </rss>`

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => feedXml,
        url: "https://huggingface.co/blog/feed.xml",
      }),
    )

    const service = new RssService()
    const result = await service.preview({} as IpcContext, {
      url: "https://huggingface.co/blog/feed.xml",
    })

    expect(result.entries[0]?.url).toBe("https://huggingface.co/blog/example-post")
  })

  it("parses only a limited number of entries in lite preview mode", async () => {
    const items = Array.from({ length: 12 }, (_, index) => {
      return `<item>
            <title>Post ${index + 1}</title>
            <guid>guid-${index + 1}</guid>
            <pubDate>Fri, 05 Jun 2026 0${index}:00:00 GMT</pubDate>
            <description><![CDATA[Short summary ${index + 1}]]></description>
            <content:encoded><![CDATA[<p>Very long body ${index + 1}</p>]]></content:encoded>
          </item>`
    }).join("")

    const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Lite Feed</title>
          <link>https://example.com</link>
          <description>Feed description</description>
          ${items}
        </channel>
      </rss>`

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => feedXml,
        url: "https://example.com/feed.xml",
      }),
    )

    const service = new RssService()
    const result = await service.preview({} as IpcContext, {
      url: "https://example.com/feed.xml",
      lite: true,
      limit: 3,
    })

    expect(result.feed.title).toBe("Lite Feed")
    expect(result.entries).toHaveLength(3)
    expect(result.entries[0]?.content).toBeNull()
    expect(result.entries[0]?.description).toBe("Short summary 1")
  })
})
