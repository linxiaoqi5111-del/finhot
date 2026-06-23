import { getViewList } from "@follow/constants"
import type { RssRefreshIntervalMinutes } from "@follow/shared/settings/interface"
import { invalidateEntriesQuery } from "@follow/store/entry/hooks"
import { useSyncExternalStore } from "react"

import { getGeneralSettings } from "~/atoms/settings/general"

import {
  cleanupDefaultFeedsIfNeeded,
  refreshAllLocalRssFeeds,
  seedDefaultLocalRssFeedsIfNeeded,
} from "./service"

export const RSS_REFRESH_INTERVAL_OPTIONS = [
  15, 30, 60, 120,
] as const satisfies readonly RssRefreshIntervalMinutes[]
export const DEFAULT_RSS_REFRESH_INTERVAL_MINUTES: RssRefreshIntervalMinutes = 60
export const RSS_LAST_REFRESHED_AT_KEY = "local-rss:last-refreshed-at"
export const RSS_STARTUP_REFRESH_DELAY_MS = 10_000

export type RssRefreshReason = "startup" | "interval" | "wake" | "manual"

type SchedulerState = {
  isRefreshing: boolean
  lastRefreshedAt: number | null
}

const listeners = new Set<() => void>()
let isRefreshing = false
let lastRefreshedAt: number | null = null
let lastRefreshedAtLoaded = false

let cachedSnapshot: SchedulerState = {
  isRefreshing: false,
  lastRefreshedAt: null,
}

const readLastRefreshedAtFromStorage = (): number | null => {
  try {
    const raw = localStorage.getItem(RSS_LAST_REFRESHED_AT_KEY)
    if (!raw) return null
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

const writeLastRefreshedAtToStorage = (timestamp: number) => {
  try {
    localStorage.setItem(RSS_LAST_REFRESHED_AT_KEY, String(timestamp))
  } catch {
    // ignore storage failures
  }
}

const ensureLastRefreshedAtLoaded = () => {
  if (lastRefreshedAtLoaded) return
  lastRefreshedAt = readLastRefreshedAtFromStorage()
  lastRefreshedAtLoaded = true
}

const getSnapshot = (): SchedulerState => {
  ensureLastRefreshedAtLoaded()
  if (
    cachedSnapshot.isRefreshing === isRefreshing &&
    cachedSnapshot.lastRefreshedAt === lastRefreshedAt
  ) {
    return cachedSnapshot
  }

  cachedSnapshot = { isRefreshing, lastRefreshedAt }
  return cachedSnapshot
}

const emit = () => {
  listeners.forEach((listener) => listener())
}

export const subscribeLocalRssRefreshState = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const getLocalRssRefreshState = (): SchedulerState => getSnapshot()

export const shouldRefreshLocalRssFeeds = (options?: {
  enabled?: boolean
  intervalMinutes?: RssRefreshIntervalMinutes
}): boolean => {
  const settings = getGeneralSettings()
  const enabled = options?.enabled ?? settings.autoRefreshRss
  if (!enabled) return false

  ensureLastRefreshedAtLoaded()

  const intervalMinutes =
    options?.intervalMinutes ??
    settings.autoRefreshRssIntervalMinutes ??
    DEFAULT_RSS_REFRESH_INTERVAL_MINUTES
  if (lastRefreshedAt === null) return true

  return Date.now() - lastRefreshedAt >= intervalMinutes * 60 * 1000
}

const markRefreshed = () => {
  lastRefreshedAt = Date.now()
  lastRefreshedAtLoaded = true
  writeLastRefreshedAtToStorage(lastRefreshedAt)
}

const invalidateAllEntryViews = async () => {
  const views = getViewList({ includeAll: true }).map((view) => view.view)
  await invalidateEntriesQuery({ views })
}

export async function runLocalRssRefresh(
  reason: RssRefreshReason,
): Promise<{ skipped: boolean; successCount?: number; failureCount?: number }> {
  if (isRefreshing) {
    return { skipped: true }
  }

  if (reason !== "manual" && !shouldRefreshLocalRssFeeds()) {
    return { skipped: true }
  }

  isRefreshing = true
  emit()

  try {
    const seedResult = await seedDefaultLocalRssFeedsIfNeeded()
    if (seedResult.seeded) {
      markRefreshed()
      await invalidateAllEntryViews()
      return {
        skipped: false,
        successCount: seedResult.successCount,
        failureCount: seedResult.failureCount,
      }
    }

    const { successCount, failureCount } = await refreshAllLocalRssFeeds()

    if (successCount > 0) {
      markRefreshed()
      await invalidateAllEntryViews()
    }

    return { skipped: false, successCount, failureCount }
  } finally {
    isRefreshing = false
    emit()
  }
}

export async function runLocalRssStartup(): Promise<{
  skipped: boolean
  successCount?: number
  failureCount?: number
}> {
  if (isRefreshing) {
    return { skipped: true }
  }

  isRefreshing = true
  emit()

  try {
    await cleanupDefaultFeedsIfNeeded()

    const seedResult = await seedDefaultLocalRssFeedsIfNeeded()
    if (seedResult.seeded) {
      markRefreshed()
      await invalidateAllEntryViews()
      return {
        skipped: false,
        successCount: seedResult.successCount,
        failureCount: seedResult.failureCount,
      }
    }
  } finally {
    isRefreshing = false
    emit()
  }

  if (!shouldRefreshLocalRssFeeds()) {
    return { skipped: true }
  }

  return runLocalRssRefresh("startup")
}

export const localRssRefreshScheduler = {
  runRefresh: runLocalRssRefresh,
  shouldRefresh: shouldRefreshLocalRssFeeds,
  getState: getLocalRssRefreshState,
  subscribe: subscribeLocalRssRefreshState,
}

export const useLocalRssRefreshState = () =>
  useSyncExternalStore(
    subscribeLocalRssRefreshState,
    getLocalRssRefreshState,
    getLocalRssRefreshState,
  )

export const resetLocalRssRefreshSchedulerForTests = () => {
  isRefreshing = false
  lastRefreshedAt = null
  lastRefreshedAtLoaded = false
  cachedSnapshot = { isRefreshing: false, lastRefreshedAt: null }
  localStorage.removeItem(RSS_LAST_REFRESHED_AT_KEY)
  listeners.clear()
}
