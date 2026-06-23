import { entryRankScoreService } from "@follow/database/services/entry-rank-score"
import type { EntryRankRecord } from "@follow/shared/entry-rank-score"
import { composeRankWithInterest } from "@follow/shared/entry-rank-score"

import type { Hydratable, Resetable } from "../../lib/base"
import { createImmerSetter, createTransaction, createZustandStore } from "../../lib/helper"
import { isEntryStarred } from "../collection/getter"
import { useEntryStore } from "../entry/store"
import { entryEmbeddingActions } from "../entry-embedding/store"
import { entryQualityScoreActions } from "../entry-quality-score/store"
import { interestClusterActions } from "../interest-cluster/store"

const getEntry = (entryId: string) => useEntryStore.getState().data[entryId]

interface EntryRankScoreState {
  data: Record<string, EntryRankRecord>
}

const defaultState: EntryRankScoreState = {
  data: {},
}

export const useEntryRankScoreStore = createZustandStore<EntryRankScoreState>("entry-rank-score")(
  () => defaultState,
)

const get = useEntryRankScoreStore.getState
const set = useEntryRankScoreStore.setState
const immerSet = createImmerSetter(useEntryRankScoreStore)

class EntryRankScoreActions implements Hydratable, Resetable {
  async hydrate() {
    const records = await entryRankScoreService.getAllScores()
    immerSet((state) => {
      records.forEach((record) => {
        state.data[record.entryId] = record.data
      })
    })
  }

  async reset() {
    const tx = createTransaction()
    tx.store(() => {
      set(defaultState)
    })
    tx.persist(() => entryRankScoreService.reset())
    await tx.run()
  }

  upsertManyInSession(records: Array<{ entryId: string; data: EntryRankRecord }>) {
    immerSet((state) => {
      records.forEach((record) => {
        state.data[record.entryId] = record.data
      })
    })
  }

  async upsertMany(records: Array<{ entryId: string; data: EntryRankRecord }>) {
    this.upsertManyInSession(records)

    await Promise.all(
      records.map((record) =>
        entryRankScoreService.upsertScore({
          entryId: record.entryId,
          data: record.data,
        }),
      ),
    )
  }

  getRank(entryId: string) {
    return get().data[entryId]
  }
}

export const entryRankScoreActions = new EntryRankScoreActions()

class EntryRankScoreSyncService {
  async recomputeForEntry(entryId: string, options?: { force?: boolean }) {
    const entry = getEntry(entryId)
    if (!entry) return null

    if (!options?.force) {
      const existing = entryRankScoreActions.getRank(entryId)
      if (existing) return existing
    }

    const qualityRecord = entryQualityScoreActions.getScore(entryId) ?? null
    const embedding = entryEmbeddingActions.getEmbedding(entryId)?.vector ?? null
    const clusters = interestClusterActions.getAllClusters()
    const record = composeRankWithInterest({
      publishedAt: entry.publishedAt,
      insertedAt: entry.insertedAt,
      qualityRecord,
      embedding,
      clusters,
    })

    await entryRankScoreActions.upsertMany([{ entryId, data: record }])
    return record
  }

  async recomputeForEntries(
    entryIds: string[],
    options?: { force?: boolean; onlyMissing?: boolean },
  ) {
    const targetEntryIds =
      options?.onlyMissing && !options.force
        ? entryIds.filter((entryId) => !entryRankScoreActions.getRank(entryId))
        : entryIds

    if (targetEntryIds.length === 0) return []

    const records: Array<{ entryId: string; data: EntryRankRecord }> = []

    for (const entryId of targetEntryIds) {
      const record = await this.recomputeForEntry(entryId, options)
      if (record) {
        records.push({ entryId, data: record })
      }
    }

    return records
  }
}

export const entryRankScoreSyncService = new EntryRankScoreSyncService()

export const getEntryRankSortContext = () => ({
  getBaseRank: (entryId: string) => entryRankScoreActions.getRank(entryId),
  getPublishedAt: (entryId: string) => getEntry(entryId)?.publishedAt,
  getEntryState: (entryId: string) => {
    const entry = getEntry(entryId)
    if (!entry) return

    return {
      read: Boolean(entry.read),
      starred: isEntryStarred(entryId),
    }
  },
})
