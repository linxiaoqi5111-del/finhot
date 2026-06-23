import { entryEmbeddingService } from "@follow/database/services/entry-embedding"
import type { EntryEmbeddingRecord } from "@follow/shared/entry-embedding"

import { embeddingGenerator } from "../../context"
import type { Hydratable, Resetable } from "../../lib/base"
import { createImmerSetter, createTransaction, createZustandStore } from "../../lib/helper"
import { getEntry } from "../entry/getter"
import { entryRankScoreSyncService } from "../entry-rank-score/store"
import {
  buildEmbeddingSourceText,
  hasEmbeddingEligibleText,
  hashEmbeddingSourceText,
  isEmbeddingStaleForEntry,
} from "./source-text"

interface EntryEmbeddingState {
  data: Record<string, EntryEmbeddingRecord>
}

const defaultState: EntryEmbeddingState = {
  data: {},
}

export const useEntryEmbeddingStore = createZustandStore<EntryEmbeddingState>("entry-embedding")(
  () => defaultState,
)

const get = useEntryEmbeddingStore.getState
const set = useEntryEmbeddingStore.setState
const immerSet = createImmerSetter(useEntryEmbeddingStore)

class EntryEmbeddingActions implements Hydratable, Resetable {
  async hydrate() {
    const records = await entryEmbeddingService.getAllEmbeddings()
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
    tx.persist(() => entryEmbeddingService.reset())
    await tx.run()
  }

  upsertManyInSession(records: Array<{ entryId: string; data: EntryEmbeddingRecord }>) {
    immerSet((state) => {
      records.forEach((record) => {
        state.data[record.entryId] = record.data
      })
    })
  }

  async upsertMany(records: Array<{ entryId: string; data: EntryEmbeddingRecord }>) {
    this.upsertManyInSession(records)

    await Promise.all(
      records.map((record) =>
        entryEmbeddingService.upsertEmbedding({
          entryId: record.entryId,
          data: record.data,
        }),
      ),
    )
  }

  getEmbedding(entryId: string) {
    return get().data[entryId]
  }

  deleteEmbeddingInSession(entryId: string) {
    immerSet((state) => {
      delete state.data[entryId]
    })
  }

  async deleteEmbedding(entryId: string) {
    this.deleteEmbeddingInSession(entryId)
    await entryEmbeddingService.deleteEmbedding(entryId)
  }
}

export const entryEmbeddingActions = new EntryEmbeddingActions()

class EntryEmbeddingSyncService {
  async generateEmbedding({ entryId, force = false }: { entryId: string; force?: boolean }) {
    const entry = getEntry(entryId)
    if (!entry || entry.read) return null
    if (!hasEmbeddingEligibleText(entry)) return null

    const existing = entryEmbeddingActions.getEmbedding(entryId)
    if (!force && existing && !isEmbeddingStaleForEntry(entry, existing)) {
      return existing
    }

    if (existing) {
      await entryEmbeddingActions.deleteEmbedding(entryId)
    }

    const generator = embeddingGenerator()
    if (!generator) return null

    const sourceText = buildEmbeddingSourceText(entry)
    if (!sourceText) return null

    const generated = await generator({
      entryId,
      text: sourceText,
    })

    if (!generated) return null

    const record = {
      ...generated,
      sourceHash: hashEmbeddingSourceText(sourceText),
    }

    await entryEmbeddingActions.upsertMany([{ entryId, data: record }])
    await entryRankScoreSyncService.recomputeForEntry(entryId, { force: true })
    return record
  }
}

export const entryEmbeddingSyncService = new EntryEmbeddingSyncService()
