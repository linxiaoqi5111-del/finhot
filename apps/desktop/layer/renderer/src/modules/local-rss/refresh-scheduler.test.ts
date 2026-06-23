import { FeedViewType } from "@follow/constants"
import { defaultGeneralSettings } from "@follow/shared/settings/defaults"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import {
  resetLocalRssRefreshSchedulerForTests,
  RSS_LAST_REFRESHED_AT_KEY,
  runLocalRssRefresh,
  runLocalRssStartup,
  shouldRefreshLocalRssFeeds,
} from "./refresh-scheduler"

const {
  getGeneralSettingsMock,
  refreshAllLocalRssFeedsMock,
  seedDefaultLocalRssFeedsIfNeededMock,
  invalidateEntriesQueryMock,
} = vi.hoisted(() => ({
  getGeneralSettingsMock: vi.fn(),
  refreshAllLocalRssFeedsMock: vi.fn(),
  seedDefaultLocalRssFeedsIfNeededMock: vi.fn(),
  invalidateEntriesQueryMock: vi.fn(),
}))

vi.mock("~/atoms/settings/general", () => ({
  getGeneralSettings: getGeneralSettingsMock,
}))

vi.mock("./service", () => ({
  refreshAllLocalRssFeeds: refreshAllLocalRssFeedsMock,
  seedDefaultLocalRssFeedsIfNeeded: seedDefaultLocalRssFeedsIfNeededMock,
}))

vi.mock("@follow/store/entry/hooks", () => ({
  invalidateEntriesQuery: invalidateEntriesQueryMock,
}))

vi.mock("@follow/constants", async (importOriginal) => {
  const original = await importOriginal<typeof import("@follow/constants")>()
  return {
    ...original,
    getViewList: () => [{ view: FeedViewType.All }],
  }
})

describe("localRssRefreshScheduler", () => {
  beforeEach(() => {
    resetLocalRssRefreshSchedulerForTests()
    getGeneralSettingsMock.mockReturnValue({
      ...defaultGeneralSettings,
      autoRefreshRss: true,
      autoRefreshRssIntervalMinutes: 60,
      autoRefreshRssOnWake: true,
    })
    refreshAllLocalRssFeedsMock.mockResolvedValue({ successCount: 1, failureCount: 0 })
    seedDefaultLocalRssFeedsIfNeededMock.mockResolvedValue({
      seeded: false,
      successCount: 0,
      failureCount: 0,
    })
    invalidateEntriesQueryMock.mockResolvedValue(void 0)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  test("shouldRefresh returns true when auto refresh is enabled and never refreshed", () => {
    expect(shouldRefreshLocalRssFeeds()).toBe(true)
  })

  test("shouldRefresh returns false when auto refresh is disabled", () => {
    getGeneralSettingsMock.mockReturnValue({
      ...defaultGeneralSettings,
      autoRefreshRss: false,
    })

    expect(shouldRefreshLocalRssFeeds()).toBe(false)
  })

  test("shouldRefresh returns false when interval has not elapsed", () => {
    localStorage.setItem(RSS_LAST_REFRESHED_AT_KEY, String(Date.now()))

    expect(shouldRefreshLocalRssFeeds()).toBe(false)
  })

  test("shouldRefresh returns true when interval has elapsed", () => {
    localStorage.setItem(RSS_LAST_REFRESHED_AT_KEY, String(Date.now() - 61 * 60 * 1000))

    expect(shouldRefreshLocalRssFeeds()).toBe(true)
  })

  test("runRefresh skips concurrent refresh attempts", async () => {
    let resolveRefresh: (() => void) | undefined
    refreshAllLocalRssFeedsMock.mockImplementation(
      () =>
        new Promise<{ successCount: number; failureCount: number }>((resolve) => {
          resolveRefresh = () => resolve({ successCount: 1, failureCount: 0 })
        }),
    )

    const firstRefresh = runLocalRssRefresh("manual")
    const secondRefresh = await runLocalRssRefresh("manual")

    expect(secondRefresh.skipped).toBe(true)
    resolveRefresh?.()
    await firstRefresh
  })

  test("runRefresh writes last refreshed timestamp after successful refresh", async () => {
    await runLocalRssRefresh("manual")

    expect(localStorage.getItem(RSS_LAST_REFRESHED_AT_KEY)).not.toBeNull()
    expect(refreshAllLocalRssFeedsMock).toHaveBeenCalledTimes(1)
    expect(invalidateEntriesQueryMock).toHaveBeenCalledWith({
      views: [FeedViewType.All],
    })
  })

  test("runRefresh seeds default feeds without running duplicate refresh", async () => {
    seedDefaultLocalRssFeedsIfNeededMock.mockResolvedValue({
      seeded: true,
      successCount: 5,
      failureCount: 0,
    })

    const result = await runLocalRssRefresh("manual")

    expect(result).toEqual({ skipped: false, successCount: 5, failureCount: 0 })
    expect(localStorage.getItem(RSS_LAST_REFRESHED_AT_KEY)).not.toBeNull()
    expect(refreshAllLocalRssFeedsMock).not.toHaveBeenCalled()
    expect(invalidateEntriesQueryMock).toHaveBeenCalledWith({
      views: [FeedViewType.All],
    })
  })

  test("runRefresh does not update timestamp when all feeds fail", async () => {
    refreshAllLocalRssFeedsMock.mockResolvedValue({ successCount: 0, failureCount: 2 })

    await runLocalRssRefresh("manual")

    expect(localStorage.getItem(RSS_LAST_REFRESHED_AT_KEY)).toBeNull()
    expect(invalidateEntriesQueryMock).not.toHaveBeenCalled()
  })

  test("runRefresh skips scheduled refresh when interval has not elapsed", async () => {
    localStorage.setItem(RSS_LAST_REFRESHED_AT_KEY, String(Date.now()))

    const result = await runLocalRssRefresh("interval")

    expect(result.skipped).toBe(true)
    expect(refreshAllLocalRssFeedsMock).not.toHaveBeenCalled()
  })

  test("startup attempts default feed seeding even when refresh interval has not elapsed", async () => {
    localStorage.setItem(RSS_LAST_REFRESHED_AT_KEY, String(Date.now()))
    seedDefaultLocalRssFeedsIfNeededMock.mockResolvedValue({
      seeded: true,
      successCount: 5,
      failureCount: 0,
    })

    const result = await runLocalRssStartup()

    expect(result).toEqual({ skipped: false, successCount: 5, failureCount: 0 })
    expect(refreshAllLocalRssFeedsMock).not.toHaveBeenCalled()
    expect(invalidateEntriesQueryMock).toHaveBeenCalledWith({
      views: [FeedViewType.All],
    })
  })
})
