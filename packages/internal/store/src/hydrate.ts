import { initializeDB, migrateDB } from "@follow/database/db"
import { LOCAL_RSS_MODE } from "@follow/shared/constants"

import type { Hydratable } from "./lib/base"
import { behaviorEventActions } from "./modules/behavior-event/store"
import { collectionActions } from "./modules/collection/store"
import { entryActions, useEntryStore } from "./modules/entry/store"
import { entryEmbeddingActions } from "./modules/entry-embedding/store"
import { entryQualityScoreActions } from "./modules/entry-quality-score/store"
import { entryRankScoreActions } from "./modules/entry-rank-score/store"
import { entryAiTagsActions } from "./modules/entry-tags/store"
import { feedActions } from "./modules/feed/store"
import { imageActions } from "./modules/image/store"
import { inboxActions } from "./modules/inbox/store"
import { interestClusterActions } from "./modules/interest-cluster/store"
import { listActions } from "./modules/list/store"
import { subscriptionActions, useSubscriptionStore } from "./modules/subscription/store"
import { summaryActions } from "./modules/summary/store"
import { translationActions } from "./modules/translation/store"
import { unreadActions } from "./modules/unread/store"
import { userActions } from "./modules/user/store"

const hydrates: Hydratable[] = [
  feedActions,
  subscriptionActions,
  inboxActions,
  listActions,
  unreadActions,
  userActions,
  entryActions,
  entryAiTagsActions,
  entryQualityScoreActions,
  entryEmbeddingActions,
  entryRankScoreActions,
  behaviorEventActions,
  interestClusterActions,
  collectionActions,
  summaryActions,
  translationActions,
  imageActions,
]

/**
 * After hydration, `getEntriesToHydrate` deletes entries beyond the 20-per-feed cap from
 * `entriesTable` without updating `unreadTable`. This leaves stale aggregate counts in
 * `unreadTable` (e.g. badge shows 55 unread but "All Unread" entry list is empty).
 *
 * This function reconciles the two by recomputing per-feed unread counts from the actual
 * in-memory entry state and persisting the corrected values back to `unreadTable`.
 */
const reconcileLocalRssUnreadCounts = async () => {
  const entryData = useEntryStore.getState().data
  const subscriptionData = useSubscriptionStore.getState().data

  const unreadByFeedId: Record<string, number> = {}
  for (const entry of Object.values(entryData)) {
    if (!entry || entry.read) continue
    const { feedId } = entry
    if (!feedId) continue
    unreadByFeedId[feedId] = (unreadByFeedId[feedId] ?? 0) + 1
  }

  const updates = Object.keys(subscriptionData).map((feedId) => ({
    id: feedId,
    count: unreadByFeedId[feedId] ?? 0,
  }))

  if (updates.length > 0) {
    await unreadActions.upsertMany(updates, { reset: true })
  }
}

export const hydrateDatabaseToStore = async (options?: { migrateDatabase?: boolean }) => {
  if (options?.migrateDatabase) {
    await initializeDB()
    await migrateDB()
  }
  await Promise.all(hydrates.map((h) => h.hydrate()))

  if (LOCAL_RSS_MODE) {
    await subscriptionActions.correctMisclassifiedVideoSubscriptions()
    await reconcileLocalRssUnreadCounts()
  }
}
