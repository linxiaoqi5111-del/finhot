/* eslint-disable @eslint-react/hooks-extra/ensure-custom-hooks-using-other-hooks, @eslint-react/hooks-extra/no-unnecessary-use-prefix -- mocked hooks must keep production export names */
import { FeedViewType } from "@follow/constants"
import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"

import { EntryListHeader } from "./EntryListHeader"

vi.mock("@follow/components/ui/button/index.js", () => ({
  ActionButton: ({
    children,
    disabled,
    onClick,
    tooltip,
  }: {
    children: React.ReactNode
    disabled?: boolean
    onClick?: () => void
    tooltip?: React.ReactNode
  }) => (
    <button
      type="button"
      disabled={disabled}
      title={typeof tooltip === "string" ? tooltip : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  ),
  MotionButtonBase: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}))

vi.mock("@follow/components/ui/divider/index.js", () => ({
  DividerVertical: () => <span data-testid="divider" />,
}))

vi.mock("@follow/components/ui/typography/index.js", () => ({
  EllipsisHorizontalTextWithTooltip: ({
    children,
    className,
  }: {
    children: React.ReactNode
    className?: string
  }) => (
    <span className={className} data-testid="header-title">
      {children}
    </span>
  ),
}))

vi.mock("@follow/shared/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@follow/shared/constants")>()
  return {
    ...actual,
    LOCAL_RSS_MODE: true,
  }
})

vi.mock("@follow/store/feed/getter", () => ({
  getFeedById: () => {},
}))

vi.mock("@follow/store/user/hooks", () => ({
  useIsLoggedIn: () => true,
}))

const unreadState = vi.hoisted(() => ({
  collectionEntryIds: ["entry-unread"],
  entries: {
    "entry-unread": { read: false },
  } as Record<string, { read: boolean } | undefined>,
  currentScopeUnread: 1,
}))

const headerState = vi.hoisted(() => ({
  title: "Starred",
}))

vi.mock("@follow/store/collection/hooks", () => ({
  useAllCollectionEntryList: () => unreadState.collectionEntryIds,
  useCollectionEntryList: () => unreadState.collectionEntryIds,
}))

vi.mock("@follow/store/entry/store", () => ({
  useEntryStore: (selector: (state: { data: typeof unreadState.entries }) => unknown) =>
    selector({ data: unreadState.entries }),
}))

vi.mock("@follow/store/subscription/selectors", () => ({
  folderFeedsByFeedIdSelector: () => () => [],
}))

vi.mock("@follow/store/subscription/store", () => ({
  useSubscriptionStore: (selector: (state: unknown) => unknown) => selector({}),
}))

vi.mock("@follow/store/unread/hooks", () => ({
  useUnreadAll: () => unreadState.currentScopeUnread,
  useUnreadById: () => unreadState.currentScopeUnread,
  useUnreadByIds: () => unreadState.currentScopeUnread,
  useUnreadByListId: () => unreadState.currentScopeUnread,
  useUnreadByView: () => unreadState.currentScopeUnread,
}))

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>()
  return {
    ...actual,
    useAtom: () => [false, vi.fn()],
    useAtomValue: () => false,
  }
})

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  const labels: Record<string, string> = {
    "entry_list_header.latest": "Latest",
    "entry_list_header.latest_timeline": "Latest timeline",
    "entry_list_header.recommended": "Recommended",
    "entry_list_header.recommended_timeline": "Recommended timeline",
    "entry_list_header.refetch": "Refetch",
    "entry_list_header.show_unread_only": "Show Unread Only",
  }

  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => labels[key] ?? key,
    }),
  }
})

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock("~/atoms/preview", () => ({
  previewBackPath: () => "",
}))

vi.mock("~/atoms/settings/general", () => ({
  useGeneralSettingKey: () => false,
}))

vi.mock("~/atoms/sidebar", () => ({
  useSubscriptionColumnShow: () => true,
}))

vi.mock("~/hooks/biz/useFeature", () => ({
  useFeature: () => false,
}))

vi.mock("~/hooks/biz/useFollow", () => ({
  useFollow: () => vi.fn(),
}))

vi.mock("~/hooks/biz/useRouteParams", () => ({
  getRouteParams: () => ({
    feedId: "collections",
    view: FeedViewType.All,
    isCollection: true,
  }),
  useRouteParams: () => ({
    feedId: "collections",
    entryId: "pending",
    view: FeedViewType.All,
    isCollection: true,
  }),
}))

vi.mock("~/hooks/common", () => ({
  useLoginModal: () => vi.fn(),
}))

vi.mock("~/modules/ai-chat/hooks/useSendAIShortcut", () => ({
  useSendAIShortcut: () => ({
    sendAIShortcut: vi.fn(),
  }),
}))

vi.mock("~/modules/command/hooks/use-command", () => ({
  useRunCommandFn: () => () => vi.fn(),
}))

vi.mock("~/modules/command/hooks/use-command-binding", () => ({
  useCommandShortcut: () => "U",
}))

vi.mock("~/modules/entry-content/components/entry-header", () => ({
  EntryHeader: () => null,
}))

vi.mock("~/modules/feed/feed-icon", () => ({
  FeedIcon: () => null,
}))

vi.mock("~/store/feed/hooks", () => ({
  useFeedHeaderIcon: () => {},
  useFeedHeaderTitle: () => headerState.title,
}))

vi.mock("../components/mark-all-button", () => ({
  MarkAllReadButton: ({ disabled }: { disabled?: boolean }) => (
    <button type="button" title="Mark as Read" disabled={disabled}>
      <i className="i-focal-list-checks" />
    </button>
  ),
}))

vi.mock("../hooks/useIsPreviewFeed", () => ({
  useIsPreviewFeed: () => false,
}))

vi.mock("../store/EntryColumnContext", () => ({
  useEntryRootState: () => ({
    isScrolledBeyondThreshold: {},
  }),
}))

vi.mock("./AppendTaildingDivider", () => ({
  AppendTaildingDivider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("./buttons/SwitchToMasonryButton", () => ({
  SwitchToMasonryButton: () => null,
}))

describe("EntryListHeader", () => {
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
    unreadState.collectionEntryIds = ["entry-unread"]
    unreadState.entries = {
      "entry-unread": { read: false },
    }
    unreadState.currentScopeUnread = 1
    headerState.title = "Starred"
  })

  test("shows unread toggle and mark-all actions for the starred collection route", async () => {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root!.render(<EntryListHeader />)
    })

    expect(container.querySelector("[title='Show Unread Only']")).toBeTruthy()
    expect(container.querySelector("[title='Mark as Read']")).toBeTruthy()
    expect(container.querySelector(".i-focal-list")).toBeTruthy()
    expect(container.querySelector(".i-focal-list-checks")).toBeTruthy()
  })

  test("disables unread scope actions when the current timeline has no unread entries", async () => {
    unreadState.collectionEntryIds = ["entry-read"]
    unreadState.entries = {
      "entry-read": { read: true },
    }
    unreadState.currentScopeUnread = 0

    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root!.render(<EntryListHeader />)
    })

    expect(container.querySelector<HTMLButtonElement>("[title='Show Unread Only']")?.disabled).toBe(
      true,
    )
    expect(container.querySelector<HTMLButtonElement>("[title='Mark as Read']")?.disabled).toBe(
      true,
    )
  })

  test("keeps timeline mode switch visible when the feed title is long", async () => {
    headerState.title = "Zhang Xiaojun | Business observation and a very long feed name"

    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root!.render(<EntryListHeader />)
    })

    expect(container.querySelector("[data-testid='header-title']")?.className).toContain("truncate")
    expect(container.querySelector("[role='group']")?.className).toContain("shrink-0")
    expect(container.querySelector("[role='group']")?.className).toContain("whitespace-nowrap")
  })
})
