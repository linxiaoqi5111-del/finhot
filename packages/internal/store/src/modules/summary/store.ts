import type { SummarySchema } from "@follow/database/schemas/types"
import { summaryService } from "@follow/database/services/summary"
import type { SupportedActionLanguage } from "@follow/shared"
import { toApiSupportedActionLanguage } from "@follow/shared"
import { LOCAL_RSS_MODE } from "@follow/shared/constants"

import { api, summaryGenerator } from "../../context"
import type { Hydratable, Resetable } from "../../lib/base"
import { createImmerSetter, createTransaction, createZustandStore } from "../../lib/helper"
import { getEntry } from "../entry/getter"
import { SummaryGeneratingStatus } from "./enum"
import type { StatusID } from "./utils"
import { getGenerateSummaryStatusId } from "./utils"

type SummaryModel = Omit<SummarySchema, "createdAt">

interface SummaryData {
  summary: string
  readabilitySummary: string | null
  lastAccessed: number
}

interface SummaryState {
  /**
   * Key: entryId
   * Value: language -> SummaryData
   */
  data: Record<string, Partial<Record<SupportedActionLanguage, SummaryData>>>

  generatingStatus: Record<StatusID, SummaryGeneratingStatus>
}
const emptyDataSet: Record<string, Partial<Record<SupportedActionLanguage, SummaryData>>> = {}

export const useSummaryStore = createZustandStore<SummaryState>("summary")(() => ({
  data: emptyDataSet,
  generatingStatus: {},
}))

const get = useSummaryStore.getState
const set = useSummaryStore.setState
const immerSet = createImmerSetter(useSummaryStore)
class SummaryActions implements Resetable, Hydratable {
  async hydrate() {
    const summaries = await summaryService.getAllSummaries()
    this.upsertManyInSession(summaries)
  }

  upsertManyInSession(summaries: SummaryModel[]) {
    const now = Date.now()
    immerSet((state) => {
      summaries.forEach((summary) => {
        if (!summary.language) return

        if (!state.data[summary.entryId]) {
          state.data[summary.entryId] = {}
        }
        if (!state.data[summary.entryId]![summary.language]) {
          state.data[summary.entryId]![summary.language] = {
            summary: "",
            readabilitySummary: null,
            lastAccessed: now,
          }
        }

        state.data[summary.entryId]![summary.language] = {
          summary: summary.summary || state.data[summary.entryId]![summary.language]!.summary || "",
          readabilitySummary:
            summary.readabilitySummary ||
            state.data[summary.entryId]![summary.language]!.readabilitySummary ||
            null,
          lastAccessed: now,
        }
      })
    })

    this.batchClean()
  }

  async upsertMany(summaries: SummaryModel[]) {
    this.upsertManyInSession(summaries)

    for (const summary of summaries) {
      summaryService.insertSummary(summary)
    }
  }

  getSummary(entryId: string, language: SupportedActionLanguage) {
    const state = get()
    const summary = state.data[entryId]?.[language]

    if (summary) {
      immerSet((state) => {
        if (state.data[entryId]) {
          state.data[entryId]![language]!.lastAccessed = Date.now()
        }
      })
    }

    return summary
  }

  private batchClean() {
    const state = get()
    const entries = Object.entries(state.data)
      .map(([, data]) => data)
      .flatMap((data) => Object.entries(data))

    if (entries.length <= 10) return

    const sortedEntries = entries.sort(
      ([, a], [, b]) => (a?.lastAccessed || 0) - (b?.lastAccessed || 0),
    )

    const entriesToRemove = sortedEntries.slice(0, entries.length - 10)

    immerSet((state) => {
      entriesToRemove.forEach(([entryId]) => {
        delete state.data[entryId]
      })
    })
  }

  async reset() {
    const tx = createTransaction()
    tx.store(() => {
      set({
        data: emptyDataSet,
        generatingStatus: {},
      })
    })
    tx.persist(() => {
      summaryService.reset()
    })

    await tx.run()
  }
}

export const summaryActions = new SummaryActions()

class SummarySyncService {
  private pendingPromises: Record<StatusID, Promise<string | null>> = {}

  async generateSummary({
    entryId,
    target,
    actionLanguage,
  }: {
    entryId: string
    target: "content" | "readabilityContent"
    actionLanguage: SupportedActionLanguage
  }): Promise<string | null> {
    const entry = getEntry(entryId)
    if (!entry) return null

    const state = get()
    const existing =
      state.data[entryId]?.[actionLanguage]?.[
        target === "content" ? "summary" : "readabilitySummary"
      ]
    if (existing) {
      return existing
    }

    const statusID = getGenerateSummaryStatusId(entryId, actionLanguage, target)
    if (state.generatingStatus[statusID] === SummaryGeneratingStatus.Pending)
      return this.pendingPromises[statusID] || null

    immerSet((state) => {
      state.generatingStatus[statusID] = SummaryGeneratingStatus.Pending
    })

    const generateSummary = async () => {
      const localSummaryGenerator = summaryGenerator()
      if (localSummaryGenerator) {
        return localSummaryGenerator({
          entryId,
          entry,
          target,
          actionLanguage,
        })
      }

      if (LOCAL_RSS_MODE) {
        return null
      }

      // Use the remote AI API to generate summary outside local RSS mode.
      const summary = await api().ai.summary({
        id: entryId,
        language: toApiSupportedActionLanguage(actionLanguage),
        target,
      })
      return summary.data?.trim() ? summary.data : null
    }

    const pendingPromise = generateSummary()
      .then((generatedSummary) => {
        if (!generatedSummary) {
          immerSet((state) => {
            state.generatingStatus[statusID] = SummaryGeneratingStatus.Success
          })

          return null
        }

        immerSet((state) => {
          if (!state.data[entryId]) {
            state.data[entryId] = {}
          }

          state.data[entryId][actionLanguage] = {
            summary:
              target === "content"
                ? generatedSummary
                : state.data[entryId]?.[actionLanguage]?.summary || "",
            readabilitySummary:
              target === "readabilityContent"
                ? generatedSummary
                : state.data[entryId]?.[actionLanguage]?.readabilitySummary || null,
            lastAccessed: Date.now(),
          }
          state.generatingStatus[statusID] = SummaryGeneratingStatus.Success
        })

        return generatedSummary
      })
      .catch((error) => {
        immerSet((state) => {
          state.generatingStatus[statusID] = SummaryGeneratingStatus.Error
        })

        throw error
      })
      .finally(() => {
        delete this.pendingPromises[statusID]
      })

    this.pendingPromises[statusID] = pendingPromise
    const summary = await pendingPromise

    if (summary) {
      summaryActions.upsertMany([
        {
          entryId,
          summary: target === "content" ? summary : "",
          language: actionLanguage ?? null,
          readabilitySummary: target === "readabilityContent" ? summary : null,
        },
      ])
    }

    return summary
  }
}

export const summarySyncService = new SummarySyncService()

const DEFAULT_BACKFILL_LIMIT = 12
const DEFAULT_BACKFILL_CONCURRENCY = 2

class SummaryBackfillService {
  private queuedIds = new Set<string>()

  private hasSummary(
    entryId: string,
    language: SupportedActionLanguage,
    target: "content" | "readabilityContent",
  ) {
    const summary = summaryActions.getSummary(entryId, language)
    if (!summary) return false

    return target === "content" ? !!summary.summary : !!summary.readabilitySummary
  }

  private async runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    task: (item: T) => Promise<void>,
  ) {
    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      async (_, index) => {
        for (let itemIndex = index; itemIndex < items.length; itemIndex += concurrency) {
          await task(items[itemIndex]!)
        }
      },
    )

    await Promise.all(workers)
  }

  async backfillMissingSummaries({
    entryIds,
    actionLanguage,
    target = "content",
    limit = DEFAULT_BACKFILL_LIMIT,
    concurrency = DEFAULT_BACKFILL_CONCURRENCY,
  }: {
    entryIds: string[]
    actionLanguage: SupportedActionLanguage
    target?: "content" | "readabilityContent"
    limit?: number
    concurrency?: number
  }) {
    const candidates: string[] = []
    const seenIds = new Set<string>()

    for (const entryId of entryIds) {
      if (candidates.length >= limit) break
      if (seenIds.has(entryId)) continue
      seenIds.add(entryId)

      if (this.queuedIds.has(entryId)) continue
      if (!getEntry(entryId)) continue
      if (this.hasSummary(entryId, actionLanguage, target)) continue

      this.queuedIds.add(entryId)
      candidates.push(entryId)
    }

    if (candidates.length === 0) return

    await this.runWithConcurrency(candidates, Math.max(1, concurrency), async (entryId) => {
      try {
        await summarySyncService.generateSummary({
          entryId,
          target,
          actionLanguage,
        })
      } catch (error) {
        console.warn("[summary] Failed to backfill AI summary:", entryId, error)
      } finally {
        this.queuedIds.delete(entryId)
      }
    })
  }
}

export const summaryBackfillService = new SummaryBackfillService()
