import { FeedViewType, PRESET_FINANCE_FEEDS } from "@follow/constants"
import type { CollectionSchema, EntrySchema, FeedSchema } from "@follow/database/schemas/types"
import { applyLocalActionRulesToEntry, runLocalActionSideEffects } from "@follow/store/action/local"
import { useActionStore } from "@follow/store/action/store"
import { collectionActions } from "@follow/store/collection/store"
import { invalidateEntriesQuery } from "@follow/store/entry/hooks"
import { entryActions, entrySyncServices, useEntryStore } from "@follow/store/entry/store"
import { getFeedByIdOrUrl } from "@follow/store/feed/getter"
import { feedActions } from "@follow/store/feed/store"
import type { FeedModel } from "@follow/store/feed/types"
import { getSubscriptionByFeedId } from "@follow/store/subscription/getter"
import { subscriptionActions, useSubscriptionStore } from "@follow/store/subscription/store"
import type { SubscriptionForm } from "@follow/store/subscription/types"
import { inferSubscriptionViewFromFeed } from "@follow/store/subscription/utils"
import { unreadActions } from "@follow/store/unread/store"
import { whoami } from "@follow/store/user/getters"
import { LOCAL_USER_ID } from "@follow/store/user/store"
import type { ParsedEntry } from "@follow-app/client-sdk"

import { getActionLanguage } from "~/atoms/settings/general"
import { ipcServices } from "~/lib/client"
import {
  triggerEntryEnrichmentFromIngest,
  triggerEntryRankFromIngest,
} from "~/modules/entry-enrichment/trigger"
import { fetchAccountNameAfterAdd } from "~/modules/wechat2rss/service"

import { isSupportedLocalRssUrl, LOCAL_RSS_URL_MESSAGE } from "./url"

export const LOCAL_RSS_DEFAULT_FEEDS_SEEDED_KEY = "local-rss:default-feeds-seeded"
export const DEFAULT_LOCAL_RSS_FEED_URLS = [] as const

const toDate = (value: Date | string | null | undefined) => {
  if (!value) return null
  return value instanceof Date ? value : new Date(value)
}

const normalizeFeed = (feed: RssPreviewFeed): FeedSchema => ({
  ...feed,
  updatedAt: toDate(feed.updatedAt),
})

// Number of newest entries to keep as unread when a feed is first subscribed.
export const INITIAL_SUBSCRIPTION_UNREAD_COUNT = 5

/**
 * localStorage helpers for persisting the "historical cutoff" per feed.
 *
 * On initial subscription we only save the N newest entries to the DB.
 * We record the publishedAt of the oldest kept entry so that future
 * refreshes can silently discard entries older than that boundary,
 * preventing them from cycling back as unread when evicted by the DB cap.
 */
const getHistoricalCutoffKey = (feedId: string) => `local-rss:history-cutoff:${feedId}`

const readHistoricalCutoff = (feedId: string): Date | null => {
  try {
    const value = localStorage.getItem(getHistoricalCutoffKey(feedId))
    return value ? new Date(value) : null
  } catch {
    return null
  }
}

const writeHistoricalCutoff = (feedId: string, cutoff: Date) => {
  try {
    localStorage.setItem(getHistoricalCutoffKey(feedId), cutoff.toISOString())
  } catch {
    // Ignore storage failures; the next subscription will try again.
  }
}

const normalizeEntry = (entry: RssPreviewEntry): EntrySchema => {
  const existingEntry = useEntryStore.getState().data[entry.id]

  return {
    ...entry,
    insertedAt: toDate(entry.insertedAt) ?? new Date(),
    publishedAt: toDate(entry.publishedAt) ?? new Date(),
    readabilityUpdatedAt: toDate(entry.readabilityUpdatedAt),
    read: existingEntry?.read ?? entry.read,
  }
}

const toPreviewEntry = (entry: EntrySchema): ParsedEntry => {
  const { feedId: _feedId, content: _content, insertedAt: _insertedAt, ...previewEntry } = entry
  return previewEntry as unknown as ParsedEntry
}

const assertRssService = () => {
  if (!ipcServices?.rss?.preview) {
    return null
  }

  return ipcServices.rss
}

type RssPreviewResult = {
  feed: {
    id: string
    title: string | null
    url: string
    description: string | null
    image: string | null
    errorAt: string | null
    siteUrl: string | null
    ownerUserId: string | null
    errorMessage: string | null
    subscriptionCount: number | null
    updatesPerWeek: number | null
    latestEntryPublishedAt: string | null
    tipUserIds: string[] | null
    updatedAt: string
  }
  entries: Array<{
    id: string
    title: string | null
    url: string | null
    content: string | null
    readabilityContent: string | null
    readabilityUpdatedAt: string | null
    description: string | null
    guid: string
    author: string | null
    authorUrl: string | null
    authorAvatar: string | null
    insertedAt: string
    publishedAt: string
    media: Array<{
      url: string
      type: "photo" | "video"
      preview_image_url?: string
      width?: number
      height?: number
    }> | null
    categories: string[] | null
    attachments: Array<{
      url: string
      duration_in_seconds?: number | string
      mime_type?: string
      size_in_bytes?: number
      title?: string
    }> | null
    extra: null
    language: string | null
    feedId: string
    inboxHandle: null
    read: boolean
    sources: string[] | null
    settings: null
  }>
}
type RssPreviewFeed = RssPreviewResult["feed"]
type RssPreviewEntry = RssPreviewResult["entries"][number]

/**
 * Web fallback: fetch RSS via the Vite dev server proxy /api/rss/preview
 */
const requestPreviewViaWeb = async (
  url: string,
  options?: { lite?: boolean; limit?: number },
): Promise<RssPreviewResult> => {
  const res = await fetch("/api/rss/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, lite: options?.lite, limit: options?.limit }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "RSS fetch failed" }))
    throw new Error(err.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

const requestPreview = async (
  url: string,
  options?: {
    lite?: boolean
    limit?: number
  },
): Promise<RssPreviewResult> => {
  if (!isSupportedLocalRssUrl(url)) {
    throw new Error(LOCAL_RSS_URL_MESSAGE)
  }

  const rss = assertRssService()
  if (rss) {
    return rss.preview({ url, ...options })
  }

  // Web mode fallback: use server-side proxy
  return requestPreviewViaWeb(url, options)
}

export async function previewLocalRssFeed({ id, url }: { id?: string; url?: string }) {
  const existingFeed = getFeedByIdOrUrl({ id, url })
  const feedUrl = url || existingFeed?.url

  if (!feedUrl) {
    throw new Error("RSS URL is required")
  }

  const result = await requestPreview(feedUrl, { lite: true })
  const feed = normalizeFeed(result.feed)
  const entries = result.entries.map(normalizeEntry)

  feedActions.upsertManyInSession([feed])

  return {
    feed,
    entries: entries.map(toPreviewEntry),
    subscription: undefined,
    analytics: {
      feedId: feed.id,
      view: null,
      subscriptionCount: null,
      updatesPerWeek: null,
      latestEntryPublishedAt: feed.latestEntryPublishedAt ?? null,
      independentSubscriptionCount: null,
      activeSubscriptionCount: null,
      boostPoints: null,
    },
  }
}

const syncUnreadCountForFeed = async (feedId: string) => {
  const entries = Object.values(useEntryStore.getState().data)
  const unreadCount = entries.reduce((count, entry) => {
    if (entry.feedId !== feedId || entry.read) {
      return count
    }
    return count + 1
  }, 0)

  await unreadActions.updateById(feedId, unreadCount)
}

const applyLocalActionsToEntries = async ({
  entries,
  feed,
}: {
  entries: EntrySchema[]
  feed: FeedModel
}) => {
  const { rules } = useActionStore.getState()
  const subscription = useSubscriptionStore.getState().data[feed.id]
  const view = subscription?.view
  if (rules.length === 0) {
    return {
      entries,
      sideEffects: [],
      starredCollections: [],
      view,
    }
  }

  const nextEntries: EntrySchema[] = []
  const starredCollections: CollectionSchema[] = []
  const sideEffects: Array<ReturnType<typeof applyLocalActionRulesToEntry>> = []

  for (const entry of entries) {
    const result = applyLocalActionRulesToEntry(entry, {
      feed,
      subscription,
      view,
      rules,
    })
    sideEffects.push(result)

    if (result.blocked) continue

    if (result.starred) {
      starredCollections.push({
        createdAt: new Date().toISOString(),
        entryId: result.entry.id,
        feedId: result.entry.feedId,
        view: view ?? 0,
      })
    }
    nextEntries.push(result.entry)
  }

  return {
    entries: nextEntries,
    sideEffects,
    starredCollections,
    view,
  }
}

export async function refreshLocalRssFeed(
  feed: Pick<FeedModel, "id" | "url">,
  options?: {
    /**
     * Set true when the user is subscribing to this feed for the first time.
     * Only the newest INITIAL_SUBSCRIPTION_UNREAD_COUNT entries are kept unread
     * and sent to AI enrichment; all older historical entries are marked as read
     * so the user does not see a backlog flood and BYOK costs stay minimal.
     */
    isInitialSubscription?: boolean
  },
) {
  const { isInitialSubscription = false } = options ?? {}
  const result = await requestPreview(feed.url)
  const nextFeed = normalizeFeed(result.feed)
  let entries = result.entries.map(normalizeEntry)

  let initialUnreadIds: Set<string> | undefined
  if (isInitialSubscription) {
    // Keep only the N newest entries. Historical backlog is intentionally NOT saved to the
    // DB so it cannot be evicted by the DB cap and then resurface as unread on future refreshes.
    const sorted = [...entries].sort(
      (a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    )
    entries = sorted.slice(0, INITIAL_SUBSCRIPTION_UNREAD_COUNT)
    initialUnreadIds = new Set(entries.map((e) => e.id))

    // Record the publishedAt of the oldest kept entry as the historical cutoff.
    // Future refreshes will silently discard anything older than this boundary.
    const oldestKept = entries.at(-1)
    if (oldestKept?.publishedAt) {
      writeHistoricalCutoff(feed.id, new Date(oldestKept.publishedAt.getTime() - 1))
    }
  } else {
    // On regular refreshes, entries predating the historical cutoff are discarded entirely
    // (not saved to DB) to prevent the cap-eviction → re-appear-as-unread cycle.
    const historicalCutoff = readHistoricalCutoff(feed.id)

    if (historicalCutoff) {
      const storeData = useEntryStore.getState().data
      entries = entries.filter((entry) => {
        // Always keep entries already in the memory store (their state is known).
        if (storeData[entry.id]) return true
        // Discard entries that predate the subscription cutoff.
        if (entry.publishedAt && entry.publishedAt <= historicalCutoff) return false
        // Keep genuinely new entries (published after the cutoff).
        return true
      })
    }
  }

  const nextFeedWithIdentity = {
    ...nextFeed,
    id: feed.id,
    url: feed.url,
    errorAt: null,
    errorMessage: null,
  }

  await feedActions.upsertMany([nextFeedWithIdentity])

  // Auto-sync subscription title when feed title becomes available
  const subscription = getSubscriptionByFeedId(feed.id)
  if (subscription) {
    const subTitle = subscription.title ?? ""
    const needsSync =
      !subTitle ||
      subTitle === "微信公众号 (同步中)" ||
      subTitle.startsWith("http://localhost:") ||
      subTitle.startsWith("http://mp.weixin.qq.com") ||
      subTitle.startsWith("https://mp.weixin.qq.com")

    if (needsSync) {
      let resolvedTitle: string | null = nextFeed.title
      // If feed XML still has no title, try querying wechat2rss list for the account name
      if (!resolvedTitle && feed.url) {
        resolvedTitle = await fetchAccountNameAfterAdd(feed.url)
      }
      if (resolvedTitle && resolvedTitle !== subTitle) {
        await subscriptionActions.upsertMany([{ ...subscription, title: resolvedTitle }])
      }
    }
  }

  const entriesWithFeedId = entries.map((entry) => ({ ...entry, feedId: feed.id }))
  const actionResult = await applyLocalActionsToEntries({
    entries: entriesWithFeedId,
    feed: {
      ...nextFeedWithIdentity,
      type: "feed",
    },
  })
  if (actionResult.starredCollections.length > 0) {
    await collectionActions.upsertMany(actionResult.starredCollections)
  }
  await entryActions.upsertMany(actionResult.entries)
  const ingestedEntryIds = actionResult.entries.map((entry) => entry.id)

  if (isInitialSubscription && initialUnreadIds) {
    // Only enrich the newest entries that are kept unread; skip AI for the entire backlog.
    const enrichIds = ingestedEntryIds.filter((id) => initialUnreadIds!.has(id))
    triggerEntryEnrichmentFromIngest(enrichIds)
    triggerEntryRankFromIngest(ingestedEntryIds)
  } else {
    triggerEntryEnrichmentFromIngest(ingestedEntryIds)
    triggerEntryRankFromIngest(ingestedEntryIds)
  }
  void Promise.all(
    actionResult.sideEffects.map((result) =>
      runLocalActionSideEffects(result, {
        actionLanguage: getActionLanguage(),
        feed: {
          ...nextFeedWithIdentity,
          type: "feed",
        },
        view: actionResult.view,
        fetchReadabilityContent: async (entry) => {
          const content = await entrySyncServices.fetchEntryReadabilityContent(entry.id)
          if (!content) {
            throw new Error("No readability content returned.")
          }
        },
      }),
    ),
  )
  await syncUnreadCountForFeed(feed.id)

  return {
    feed: nextFeed,
    entries,
  }
}

export async function upsertLocalRssSubscription({
  feed,
  subscription,
}: {
  feed: FeedModel
  subscription: SubscriptionForm
}) {
  const userId = whoami()?.id ?? LOCAL_USER_ID
  const subscriptionView = Number(subscription.view)
  const inferredView = inferSubscriptionViewFromFeed(feed)
  const view = inferredView === FeedViewType.Videos ? inferredView : subscriptionView

  await subscriptionActions.upsertMany([
    {
      ...subscription,
      title: subscription.title ?? null,
      category: subscription.category ?? null,
      type: "feed",
      createdAt: new Date().toISOString(),
      feedId: feed.id,
      listId: null,
      inboxId: null,
      userId,
      view,
      isPrivate: subscription.isPrivate,
      hideFromTimeline: subscription.hideFromTimeline ?? null,
    },
  ])

  await refreshLocalRssFeed(feed, { isInitialSubscription: true })
  await invalidateEntriesQuery({ views: [view] })
}

const readDefaultFeedsSeeded = () => {
  try {
    return localStorage.getItem(LOCAL_RSS_DEFAULT_FEEDS_SEEDED_KEY) === "1"
  } catch {
    return false
  }
}

const writeDefaultFeedsSeeded = () => {
  try {
    localStorage.setItem(LOCAL_RSS_DEFAULT_FEEDS_SEEDED_KEY, "1")
  } catch {
    // Ignore storage failures; existing subscriptions still prevent duplicate seeding.
  }
}

const hasExistingLocalRssSubscriptions = () =>
  Object.values(useSubscriptionStore.getState().data).some(
    (subscription) => subscription.type === "feed" && !!subscription.feedId,
  )

const DEFAULTS_CLEANED_KEY = "finhot:defaults-cleaned"

/**
 * One-time cleanup: remove all preset/default finance feeds.
 * Keeps only user-added subscriptions (via AddBloggerPanel).
 */
export async function cleanupDefaultFeedsIfNeeded(): Promise<void> {
  try {
    if (localStorage.getItem(DEFAULTS_CLEANED_KEY) === "1") return
  } catch {
    return
  }

  const presetUrls = new Set(PRESET_FINANCE_FEEDS.map((f) => f.url))
  const state = useSubscriptionStore.getState()
  const idsToRemove: string[] = []

  for (const [id, sub] of Object.entries(state.data)) {
    if (!sub?.feedId) continue
    const feed = getFeedByIdOrUrl({ id: sub.feedId })
    if (!feed?.url) continue
    if (presetUrls.has(feed.url)) {
      idsToRemove.push(id)
    }
  }

  if (idsToRemove.length > 0) {
    await subscriptionActions.unsubscribe(idsToRemove)
  }

  try {
    localStorage.setItem(DEFAULTS_CLEANED_KEY, "1")
  } catch {
    // ignore
  }
}

export async function seedDefaultLocalRssFeedsIfNeeded(): Promise<{
  seeded: boolean
  successCount: number
  failureCount: number
}> {
  if (readDefaultFeedsSeeded()) {
    return { seeded: false, successCount: 0, failureCount: 0 }
  }

  if (hasExistingLocalRssSubscriptions()) {
    writeDefaultFeedsSeeded()
    return { seeded: false, successCount: 0, failureCount: 0 }
  }

  let successCount = 0
  let failureCount = 0

  for (const url of DEFAULT_LOCAL_RSS_FEED_URLS) {
    try {
      const { feed } = await previewLocalRssFeed({ url })
      const feedModel = {
        ...feed,
        type: "feed" as const,
      }
      await upsertLocalRssSubscription({
        feed: feedModel,
        subscription: {
          url: feed.url,
          view: FeedViewType.Articles,
          category: null,
          isPrivate: false,
          hideFromTimeline: null,
          title: feed.title,
          feedId: feed.id,
          listId: undefined,
        },
      })
      successCount += 1
    } catch (error) {
      failureCount += 1
      console.warn("[local-rss] Failed to seed default feed", { url, error })
    }
  }

  if (successCount > 0) {
    writeDefaultFeedsSeeded()
  }

  return { seeded: successCount > 0, successCount, failureCount }
}

export async function refreshAllLocalRssFeeds(): Promise<{
  successCount: number
  failureCount: number
}> {
  const subscriptions = Object.values(useSubscriptionStore.getState().data).filter(
    (subscription) => subscription.type === "feed" && subscription.feedId,
  )

  let successCount = 0
  let failureCount = 0

  for (const subscription of subscriptions) {
    const feed = getFeedByIdOrUrl({ id: subscription.feedId ?? undefined })
    if (!feed?.id || !feed.url) continue

    try {
      await refreshLocalRssFeed(feed)
      successCount += 1
    } catch (error) {
      failureCount += 1
      await feedActions.patch(feed.id, {
        errorAt: new Date().toISOString(),
        errorMessage: error instanceof Error ? error.message : "Failed to refresh RSS feed",
      })
    }
  }

  return { successCount, failureCount }
}
