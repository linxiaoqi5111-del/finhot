import { FeedViewType } from "@follow/constants"
import { applyLocalActionRulesToEntry, runLocalActionSideEffects } from "@follow/store/action/local"
import { useActionStore } from "@follow/store/action/store"
import { collectionActions } from "@follow/store/collection/store"
import { entryActions, entrySyncServices, useEntryStore } from "@follow/store/entry/store"
import { useFeedStore } from "@follow/store/feed/store"
import { useSubscriptionStore } from "@follow/store/subscription/store"

import { getActionLanguage } from "~/atoms/settings/general"

export const applyActionRulesToExistingEntries = async () => {
  const { rules } = useActionStore.getState()
  if (rules.length === 0) return 0

  const entries = Object.values(useEntryStore.getState().data)
  if (entries.length === 0) return 0

  const { feeds } = useFeedStore.getState()
  const subscriptions = useSubscriptionStore.getState().data
  const nextEntries: typeof entries = []
  const sideEffects: Array<ReturnType<typeof applyLocalActionRulesToEntry>> = []
  const starredCollections: Parameters<typeof collectionActions.upsertMany>[0] = []

  for (const entry of entries) {
    const feed = entry.feedId ? feeds[entry.feedId] : undefined
    const subscription = entry.feedId ? subscriptions[entry.feedId] : undefined
    const result = applyLocalActionRulesToEntry(entry, {
      feed,
      subscription,
      view: subscription?.view,
      rules,
    })

    sideEffects.push(result)
    if (result.blocked) continue

    nextEntries.push(result.entry)
    if (result.starred) {
      starredCollections.push({
        createdAt: new Date().toISOString(),
        entryId: result.entry.id,
        feedId: result.entry.feedId,
        view: subscription?.view ?? FeedViewType.All,
      })
    }
  }

  if (nextEntries.length > 0) {
    await entryActions.upsertMany(nextEntries)
  }
  if (starredCollections.length > 0) {
    await collectionActions.upsertMany(starredCollections)
  }

  void Promise.all(
    sideEffects.map((result) =>
      runLocalActionSideEffects(result, {
        actionLanguage: getActionLanguage(),
        feed: result.entry.feedId ? feeds[result.entry.feedId] : undefined,
        view: result.entry.feedId ? subscriptions[result.entry.feedId]?.view : undefined,
        fetchReadabilityContent: async (entry) => {
          const content = await entrySyncServices.fetchEntryReadabilityContent(entry.id)
          if (!content) {
            throw new Error("No readability content returned.")
          }
        },
      }),
    ),
  )

  return nextEntries.length
}
