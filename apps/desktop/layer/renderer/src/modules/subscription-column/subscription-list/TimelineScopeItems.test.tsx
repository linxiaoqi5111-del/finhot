/* eslint-disable @eslint-react/hooks-extra/ensure-custom-hooks-using-other-hooks, @eslint-react/hooks-extra/no-unnecessary-use-prefix -- mocked hooks must keep production export names */
import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"

import { SMART_FEED_TODAY, SMART_FEED_UNREAD } from "~/lib/timeline-scope"

import { TimelineScopeItems } from "./TimelineScopeItems"

vi.mock("@follow/store/collection/hooks", () => ({
  useAllCollectionEntryList: () => ["entry-starred-unread", "entry-starred-read"],
}))

vi.mock("@follow/store/entry/store", () => ({
  useEntryStore: (
    selector: (state: {
      data: Record<string, { id: string; publishedAt: Date; read: boolean }>
    }) => number,
  ) =>
    selector({
      data: {
        todayUnread: {
          id: "todayUnread",
          publishedAt: new Date(),
          read: false,
        },
        "entry-starred-unread": {
          id: "entry-starred-unread",
          publishedAt: new Date("2026-06-12T00:00:00.000Z"),
          read: false,
        },
        "entry-starred-read": {
          id: "entry-starred-read",
          publishedAt: new Date("2026-06-11T00:00:00.000Z"),
          read: true,
        },
      },
    }),
}))

vi.mock("@follow/store/unread/hooks", () => ({
  useUnreadAll: () => 3,
}))

vi.mock("~/hooks/biz/useNavigateEntry", () => ({
  useNavigateEntry: () => vi.fn(),
}))

vi.mock("~/hooks/biz/useRouteParams", () => ({
  useRouteParamsSelector: (selector: (params: { feedId: string }) => string) =>
    selector({ feedId: "" }),
}))

vi.mock("~/atoms/settings/ui", () => ({
  useUISettingKey: () => true,
}))

vi.mock("~/modules/starred-groups/StarredGroupChips", () => ({
  StarredGroupChips: () => <div data-testid="starred-group-chips" />,
  StarredGroupSidebarActions: () => <button type="button" data-testid="starred-group-actions" />,
}))

vi.mock("~/modules/starred-groups/store", () => ({
  selectedStarredGroupAtom: {},
  STARRED_GROUP_ALL: "all",
  starredGroupsCollapsedAtom: {},
}))

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>()
  return {
    ...actual,
    useAtom: () => [false, vi.fn()],
    useAtomValue: () => "all",
    useSetAtom: () => vi.fn(),
  }
})

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  const labels: Record<string, string> = {
    "sidebar.smart_feeds.all_unread": "All Unread",
    "sidebar.smart_feeds.title": "Smart Feeds",
    "time.today": "Today",
    "words.all": "All",
    "words.starred": "Starred",
  }

  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => labels[key] ?? key,
    }),
  }
})

const getScopeLabels = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-sub^='scope-']")).map((element) =>
    element.textContent?.replaceAll(/\d+/g, "").trim(),
  )

const getScopeText = (container: HTMLElement, feedId: string) => {
  const element = container.querySelector<HTMLElement>(`[data-sub='scope-${feedId}']`)
  if (!element) {
    throw new Error(`Scope not found: ${feedId}`)
  }

  return element.textContent?.trim()
}

const getScopeIcon = (container: HTMLElement, feedId: string) => {
  const element = container.querySelector<HTMLElement>(`[data-sub='scope-${feedId}'] i`)
  if (!element) {
    throw new Error(`Scope icon not found: ${feedId}`)
  }

  return element
}

describe("TimelineScopeItems", () => {
  let root: Root | null = null
  let container: HTMLElement | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }

    container?.remove()
    root = null
    container = null
    vi.useRealTimers()
  })

  test("starts smart feeds with Today and omits the duplicate All scope", async () => {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root!.render(<TimelineScopeItems />)
    })

    expect(getScopeLabels(container)).toEqual(["Today", "All Unread", "Starred"])
  })

  test.each([
    [new Date(2026, 5, 16, 5, 59), "i-lucide-sun-moon"],
    [new Date(2026, 5, 16, 6), "i-lucide-sun"],
    [new Date(2026, 5, 16, 17, 59), "i-lucide-sun"],
    [new Date(2026, 5, 16, 18), "i-lucide-sun-moon"],
  ])("uses the expected Today icon at %s", async (date, iconClassName) => {
    vi.useFakeTimers()
    vi.setSystemTime(date)

    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root!.render(<TimelineScopeItems />)
    })

    expect(getScopeIcon(container, SMART_FEED_TODAY).classList.contains(iconClassName)).toBe(true)
  })

  test("uses lucide scroll-text for All Unread", async () => {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root!.render(<TimelineScopeItems />)
    })

    expect(
      getScopeIcon(container, SMART_FEED_UNREAD).classList.contains("i-lucide-scroll-text"),
    ).toBe(true)
  })

  test("shows the unread starred count instead of the total starred count", async () => {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root!.render(<TimelineScopeItems />)
    })

    expect(getScopeText(container, "collections")).toBe("Starred1")
  })

  test("does not render starred group management in the smart feeds list", async () => {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root!.render(<TimelineScopeItems />)
    })

    expect(container.querySelector("[data-testid='starred-group-actions']")).toBeNull()
    expect(container.querySelector("[data-testid='starred-group-chips']")).toBeNull()
  })
})
