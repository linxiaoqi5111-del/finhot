import { entryQualityScoreService } from "@follow/database/services/entry-quality-score"
import type { EntryQualityScoreRecord } from "@follow/shared/entry-quality-score"
import type { SupportedActionLanguage } from "@follow/shared/language"
import { isYouTubeSubscriptionFeed } from "@follow/utils/url-for-video"

import { qualityScoreGenerator } from "../../context"
import type { Hydratable, Resetable } from "../../lib/base"
import { createImmerSetter, createTransaction, createZustandStore } from "../../lib/helper"
import { getEntry } from "../entry/getter"
import { entryRankScoreSyncService } from "../entry-rank-score/store"
import { getFeedById } from "../feed/getter"
import { summaryActions } from "../summary/store"
import { validateQualityScoreResult } from "./utils"

interface EntryQualityScoreState {
  data: Record<string, EntryQualityScoreRecord>
}

const defaultState: EntryQualityScoreState = {
  data: {},
}

export const useEntryQualityScoreStore = createZustandStore<EntryQualityScoreState>(
  "entry-quality-score",
)(() => defaultState)

const get = useEntryQualityScoreStore.getState
const set = useEntryQualityScoreStore.setState
const immerSet = createImmerSetter(useEntryQualityScoreStore)

class EntryQualityScoreActions implements Hydratable, Resetable {
  async hydrate() {
    const records = await entryQualityScoreService.getAllScores()
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
    tx.persist(() => entryQualityScoreService.reset())
    await tx.run()
  }

  async deleteMany(entryIds: string[]) {
    const uniqueEntryIds = [...new Set(entryIds.filter(Boolean))]
    if (uniqueEntryIds.length === 0) return

    const tx = createTransaction()
    tx.store(() => {
      immerSet((state) => {
        for (const entryId of uniqueEntryIds) {
          delete state.data[entryId]
        }
      })
    })
    tx.persist(async () => {
      await Promise.all(
        uniqueEntryIds.map((entryId) => entryQualityScoreService.deleteScore(entryId)),
      )
    })
    await tx.run()
  }

  upsertManyInSession(records: Array<{ entryId: string; data: EntryQualityScoreRecord }>) {
    immerSet((state) => {
      records.forEach((record) => {
        state.data[record.entryId] = record.data
      })
    })
  }

  async upsertMany(records: Array<{ entryId: string; data: EntryQualityScoreRecord }>) {
    this.upsertManyInSession(records)

    await Promise.all(
      records.map((record) =>
        entryQualityScoreService.upsertScore({
          entryId: record.entryId,
          data: record.data,
        }),
      ),
    )
  }

  getScore(entryId: string) {
    return get().data[entryId]
  }
}

export const entryQualityScoreActions = new EntryQualityScoreActions()

class EntryQualityScoreSyncService {
  async generateScore({
    entryId,
    actionLanguage,
    target = "content",
  }: {
    entryId: string
    actionLanguage: SupportedActionLanguage
    target?: "content" | "readabilityContent"
  }) {
    const existing = entryQualityScoreActions.getScore(entryId)
    if (existing) return existing

    const entry = getEntry(entryId)
    if (!entry) return null

    const localGenerator = qualityScoreGenerator()
    if (!localGenerator) return null

    const summaryRecord = summaryActions.getSummary(entryId, actionLanguage)
    const summary =
      target === "readabilityContent"
        ? (summaryRecord?.readabilitySummary ?? summaryRecord?.summary ?? null)
        : (summaryRecord?.summary ?? null)
    const feed = entry.feedId ? getFeedById(entry.feedId) : null
    const generated = await localGenerator({
      entryId,
      entry,
      actionLanguage,
      summary,
      source: feed?.title ?? null,
      guid: entry.guid,
      isYouTubeFeed: feed ? isYouTubeSubscriptionFeed(feed) : false,
      target,
    })

    const record = validateQualityScoreResult(generated)
    if (!record) return null

    await entryQualityScoreActions.upsertMany([{ entryId, data: record }])
    await entryRankScoreSyncService.recomputeForEntry(entryId, { force: true })
    return record
  }
}

export const entryQualityScoreSyncService = new EntryQualityScoreSyncService()
