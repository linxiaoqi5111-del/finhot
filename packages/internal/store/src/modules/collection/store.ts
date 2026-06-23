import type { FeedViewType } from "@follow/constants"
import type { CollectionSchema } from "@follow/database/schemas/types"
import { CollectionService } from "@follow/database/services/collection"
import { LOCAL_RSS_MODE } from "@follow/shared/constants"

import { api } from "../../context"
import type { Hydratable, Resetable } from "../../lib/base"
import { createTransaction, createZustandStore } from "../../lib/helper"
import { behaviorEventSyncService } from "../behavior-event/store"
import { getEntry } from "../entry/getter"
import { invalidateEntriesQuery } from "../entry/hooks"

interface CollectionState {
  collections: Record<string, CollectionSchema>
}

const defaultState = {
  collections: {},
}

export const useCollectionStore = createZustandStore<CollectionState>("collection")(
  () => defaultState,
)

const get = useCollectionStore.getState
const set = useCollectionStore.setState

class CollectionSyncService {
  async starEntry({
    entryId,
    view,
    invalidate,
  }: {
    entryId: string
    view: FeedViewType
    invalidate?: boolean
  }) {
    const entry = getEntry(entryId)
    if (!entry) {
      return
    }

    const collection = {
      createdAt: new Date().toISOString(),
      entryId,
      feedId: entry.feedId,
      view,
    }

    if (LOCAL_RSS_MODE) {
      await collectionActions.upsertMany([collection])
      void behaviorEventSyncService.recordFavorite(entryId)
      if (invalidate) {
        invalidateEntriesQuery({ collection: true })
      }
      return
    }

    const tx = createTransaction()
    tx.store(async () => {
      await collectionActions.upsertMany([collection])
    })
    tx.request(async () => {
      await api().collections.post({
        entryId,
        view,
      })
    })
    tx.rollback(() => {
      collectionActions.delete(entryId)
    })

    await tx.run()

    if (invalidate) {
      invalidateEntriesQuery({ collection: true })
    }
  }

  async unstarEntry({ entryId, invalidate = true }: { entryId: string; invalidate?: boolean }) {
    if (LOCAL_RSS_MODE) {
      await collectionActions.delete(entryId)
      if (invalidate) invalidateEntriesQuery({ collection: true })
      return
    }

    const tx = createTransaction()

    const snapshot = useCollectionStore.getState().collections[entryId]
    tx.store(() => {
      collectionActions.delete(entryId)
    })
    tx.request(async () => {
      await api().collections.delete({
        entryId,
      })
    })

    tx.rollback(() => {
      if (!snapshot) return
      collectionActions.upsertMany([snapshot])
    })

    await tx.run()

    if (invalidate) invalidateEntriesQuery({ collection: true })
  }
}

class CollectionActions implements Hydratable, Resetable {
  async hydrate() {
    const collections = await CollectionService.getCollectionAll()
    collectionActions.upsertManyInSession(collections)
  }

  upsertManyInSession(collections: CollectionSchema[], options?: { reset?: boolean }) {
    const state = get()
    const nextCollections: CollectionState["collections"] = options?.reset
      ? {}
      : {
          ...state.collections,
        }
    collections.forEach((collection) => {
      if (!collection.entryId) return
      nextCollections[collection.entryId] = collection
    })
    set({
      ...state,
      collections: nextCollections,
    })
  }

  async upsertMany(collections: CollectionSchema[], options?: { reset?: boolean }) {
    const tx = createTransaction()
    tx.store(() => {
      this.upsertManyInSession(collections, options)
    })
    tx.persist(() => {
      return CollectionService.upsertMany(collections, options)
    })
    await tx.run()
  }

  deleteInSession(entryId: string | string[]) {
    const normalizedEntryId = Array.isArray(entryId) ? entryId : [entryId]

    const state = useCollectionStore.getState()
    const nextCollections: CollectionState["collections"] = {
      ...state.collections,
    }

    normalizedEntryId.forEach((id) => {
      delete nextCollections[id]
    })
    set({
      ...state,
      collections: nextCollections,
    })
  }

  async delete(entryId: string | string[]) {
    const entryIdsInCollection = new Set(Object.keys(get().collections))
    const normalizedEntryId = (Array.isArray(entryId) ? entryId : [entryId]).filter((id) =>
      entryIdsInCollection.has(id),
    )

    if (normalizedEntryId.length === 0) return

    const tx = createTransaction()
    tx.store(() => {
      this.deleteInSession(entryId)
    })
    tx.persist(() => {
      return CollectionService.deleteMany(normalizedEntryId)
    })
    await tx.run()
  }

  async reset() {
    const tx = createTransaction()
    tx.store(() => {
      set(defaultState)
    })

    tx.persist(() => {
      return CollectionService.reset()
    })

    await tx.run()
  }
}

export const collectionActions = new CollectionActions()
export const collectionSyncService = new CollectionSyncService()
