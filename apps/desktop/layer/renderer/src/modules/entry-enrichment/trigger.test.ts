import { useActionStore } from "@follow/store/action/store"
import { useEntryStore } from "@follow/store/entry/store"
import type { EntryModel } from "@follow/store/entry/types"
import { useFeedStore } from "@follow/store/feed/store"
import { useSubscriptionStore } from "@follow/store/subscription/store"
import { beforeEach, describe, expect, it } from "vitest"

import { filterEnrichableEntryIds } from "./trigger"

const createEntry = (id: string, feedId: string): EntryModel =>
  ({
    id,
    guid: `${id}-guid`,
    title: `entry ${id}`,
    url: `https://example.com/${id}`,
    content: "",
    description: "",
    author: null,
    insertedAt: new Date("2026-01-01T00:00:00.000Z"),
    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
    feedId,
    read: false,
  }) as unknown as EntryModel

describe("filterEnrichableEntryIds", () => {
  beforeEach(() => {
    useActionStore.setState({ rules: [], isDirty: false })
    useEntryStore.setState({ data: {} } as never)
    useFeedStore.setState({ feeds: {} } as never)
    useSubscriptionStore.setState({ data: {} } as never)
  })

  it("returns all entries unchanged when no rules exist", () => {
    useEntryStore.setState({
      data: {
        a: createEntry("a", "feed-skip"),
        b: createEntry("b", "feed-keep"),
      },
    } as never)

    expect(filterEnrichableEntryIds(["a", "b"])).toEqual(["a", "b"])
  })

  it("excludes entries whose feed matches a skipEnrichment rule", () => {
    useFeedStore.setState({
      feeds: {
        "feed-skip": {
          id: "feed-skip",
          type: "feed",
          title: "Cninfo zj",
          url: "http://localhost:8787/by-category/category_zj_szsh.xml",
          siteUrl: null,
        },
        "feed-keep": {
          id: "feed-keep",
          type: "feed",
          title: "Other",
          url: "https://example.com/feed.xml",
          siteUrl: null,
        },
      },
    } as never)
    useEntryStore.setState({
      data: {
        a: createEntry("a", "feed-skip"),
        b: createEntry("b", "feed-keep"),
      },
    } as never)
    useActionStore.setState({
      rules: [
        {
          index: 0,
          name: "Skip AI for cninfo zj",
          condition: [[{ field: "feed_url", operator: "contains", value: "category_zj_szsh" }]],
          result: { skipEnrichment: true },
        },
      ],
      isDirty: false,
    })

    // The skip-ruled feed entry is filtered out; the other feed's entry is kept.
    expect(filterEnrichableEntryIds(["a", "b"])).toEqual(["b"])
  })

  it("passes through ids that are not yet loaded in the entry store", () => {
    useActionStore.setState({
      rules: [
        {
          index: 0,
          name: "Skip AI for cninfo zj",
          condition: [[{ field: "feed_url", operator: "contains", value: "category_zj_szsh" }]],
          result: { skipEnrichment: true },
        },
      ],
      isDirty: false,
    })

    expect(filterEnrichableEntryIds(["missing"])).toEqual(["missing"])
  })
})
