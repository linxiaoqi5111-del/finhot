import type { SupportedActionLanguage } from "@follow/shared"
import { checkLanguage } from "@follow/utils/language"

import { getEntry } from "../entry/getter"
import {
  getQualityScoreCoverageStats,
  listRescoreEligibleEntryIds,
  listRescoreEligibleEntryIdsByFeedIds,
} from "../entry-quality-score/backlog"
import {
  entryQualityScoreActions,
  entryQualityScoreSyncService,
} from "../entry-quality-score/store"
import { entryAiTagsActions, entryAiTagsSyncService } from "../entry-tags/store"
import { getSubscriptionByEntryId } from "../subscription/getter"
import { SummaryGeneratingStatus } from "../summary/enum"
import { summaryActions, summarySyncService, useSummaryStore } from "../summary/store"
import { getGenerateSummaryStatusId } from "../summary/utils"
import { translationActions, translationSyncService } from "../translation/store"
import { buildEnrichmentErrorKey, getEnrichmentErrorCode } from "./error-utils"
import type { EnrichmentActiveJob, EnrichmentStatusSnapshot } from "./store"
import { enrichmentStatusActions } from "./store"
import type { EnrichmentEnqueueOptions, EnrichmentJob, EnrichmentPhase } from "./types"
import { DEFAULT_ENRICHMENT_PHASES } from "./types"

export type EnrichmentRetryResult =
  | { ok: true }
  | { ok: false; reason: "missing_entry" | "unsubscribed" | "in_pipeline" | "nothing_to_do" }

const BATCH_SIZE = 6
const CONCURRENCY = 2
const JOB_TIMEOUT_MS = 90_000
const STALE_PENDING_MS = 90_000

class EntryEnrichmentService {
  private queue: EnrichmentJob[] = []
  private pendingSince = new Map<string, number>()
  private activeJobs = new Map<string, EnrichmentActiveJob>()
  private cancelledActiveEntryIds = new Set<string>()
  private isDraining = false
  private lastError: EnrichmentStatusSnapshot["lastError"] = null

  enqueueFromIngest(options: EnrichmentEnqueueOptions) {
    this.enqueueMissing({
      ...options,
      prepend: true,
    })
  }

  backfillVisible(options: EnrichmentEnqueueOptions) {
    this.enqueueMissing(options)
  }

  async rescoreAll({ actionLanguage }: { actionLanguage: SupportedActionLanguage }) {
    const entryIds = listRescoreEligibleEntryIds()
    if (entryIds.length === 0) return 0

    await entryQualityScoreActions.reset()
    this.enqueueMissing({
      entryIds,
      actionLanguage,
      phases: ["qualityScore"],
      prepend: true,
    })
    return entryIds.length
  }

  async rescoreFeeds({
    feedIds,
    actionLanguage,
  }: {
    feedIds: string[]
    actionLanguage: SupportedActionLanguage
  }) {
    const entryIds = listRescoreEligibleEntryIdsByFeedIds(feedIds)
    if (entryIds.length === 0) return 0

    const scoredEntryIds = entryIds.filter((entryId) => entryQualityScoreActions.getScore(entryId))
    if (scoredEntryIds.length > 0) {
      await entryQualityScoreActions.deleteMany(scoredEntryIds)
    }

    this.enqueueMissing({
      entryIds,
      actionLanguage,
      phases: ["qualityScore"],
      prepend: true,
    })
    return entryIds.length
  }

  isEntryInPipeline(entryId: string) {
    if (this.queue.some((job) => job.entryId === entryId)) return true
    if (this.activeJobs.has(entryId)) return true
    return this.isPending(entryId)
  }

  cancelEntriesByFeedIds(feedIds: string[]) {
    const feedIdSet = new Set(feedIds.filter(Boolean))
    if (feedIdSet.size === 0) return 0

    let cancelledCount = 0

    this.queue = this.queue.filter((job) => {
      if (!this.isEntryFromFeedIds(job.entryId, feedIdSet)) return true

      this.clearPending(job.entryId)
      cancelledCount += 1
      return false
    })

    for (const entryId of this.pendingSince.keys()) {
      if (this.activeJobs.has(entryId)) continue
      if (!this.isEntryFromFeedIds(entryId, feedIdSet)) continue

      this.clearPending(entryId)
    }

    for (const entryId of this.activeJobs.keys()) {
      if (!this.isEntryFromFeedIds(entryId, feedIdSet)) continue

      this.cancelledActiveEntryIds.add(entryId)
      cancelledCount += 1
    }

    if (cancelledCount > 0) {
      this.publishStatus()
    }

    return cancelledCount
  }

  getQualityScoreCoverageStats() {
    return getQualityScoreCoverageStats((entryId) => this.isEntryInPipeline(entryId))
  }

  retryEntry({
    entryId,
    actionLanguage,
    phases = DEFAULT_ENRICHMENT_PHASES,
    translationMode = "bilingual",
  }: {
    entryId: string
    actionLanguage: SupportedActionLanguage
    phases?: readonly EnrichmentPhase[]
    translationMode?: EnrichmentJob["translationMode"]
  }): EnrichmentRetryResult {
    if (!getEntry(entryId)) {
      return { ok: false, reason: "missing_entry" }
    }

    if (!this.isEntryStillSubscribed(entryId)) {
      return { ok: false, reason: "unsubscribed" }
    }

    if (this.isEntryInPipeline(entryId)) {
      return { ok: false, reason: "in_pipeline" }
    }

    const jobs = this.buildJobs([entryId], actionLanguage, phases, translationMode)
    if (jobs.length === 0) {
      return { ok: false, reason: "nothing_to_do" }
    }

    this.enqueueMissing({
      entryIds: [entryId],
      actionLanguage,
      phases,
      translationMode,
      prepend: true,
    })
    return { ok: true }
  }

  private enqueueMissing({
    entryIds,
    actionLanguage,
    phases = DEFAULT_ENRICHMENT_PHASES,
    translationMode = "bilingual",
    prepend = false,
  }: EnrichmentEnqueueOptions) {
    const jobs = this.buildJobs(entryIds, actionLanguage, phases, translationMode)
    if (jobs.length === 0) return

    if (prepend) {
      this.queue.unshift(...jobs)
    } else {
      this.queue.push(...jobs)
    }
    this.publishStatus()
    void this.drain()
  }

  private publishStatus() {
    enrichmentStatusActions.setSnapshot({
      queueLength: this.queue.length,
      pendingCount: this.pendingSince.size,
      isProcessing: this.isDraining,
      activeJobs: Array.from(this.activeJobs.values()),
      lastError: this.lastError,
    })
  }

  private buildJobs(
    entryIds: string[],
    actionLanguage: SupportedActionLanguage,
    phases: readonly EnrichmentPhase[],
    translationMode: EnrichmentJob["translationMode"],
  ) {
    const jobs: EnrichmentJob[] = []
    const seenIds = new Set<string>()

    for (const entryId of entryIds) {
      if (seenIds.has(entryId)) continue
      seenIds.add(entryId)

      if (this.isPending(entryId)) continue
      if (!getEntry(entryId)) continue
      if (!this.isEntryStillSubscribed(entryId)) continue
      if (this.isSummaryGenerating(entryId, actionLanguage)) continue
      if (!this.needsEnrichment(entryId, actionLanguage, phases)) continue

      this.markPending(entryId)
      jobs.push({ entryId, actionLanguage, phases, translationMode })
    }

    return jobs
  }

  private needsEnrichment(
    entryId: string,
    actionLanguage: SupportedActionLanguage,
    phases: readonly EnrichmentPhase[],
  ) {
    return phases.some((phase) => this.isPhaseMissing(entryId, actionLanguage, phase))
  }

  private isPhaseMissing(
    entryId: string,
    actionLanguage: SupportedActionLanguage,
    phase: EnrichmentPhase,
  ) {
    switch (phase) {
      case "summary": {
        const summary = summaryActions.getSummary(entryId, actionLanguage)
        return !summary?.summary
      }
      case "titleTranslation": {
        const entry = getEntry(entryId)
        if (!entry?.title) return false

        const translation = translationActions.getTranslation(entryId, actionLanguage)
        if (translation?.title) return false

        return !checkLanguage({
          content: entry.title,
          language: actionLanguage,
        })
      }
      case "tags": {
        const tags = entryAiTagsActions.getTags(entryId)
        if (!tags?.length) return true
        // Backfill contentType for entries tagged before the field existed.
        return !entryAiTagsActions.getContentType(entryId)
      }
      case "qualityScore": {
        const entry = getEntry(entryId)
        if (!entry) return false

        return !entryQualityScoreActions.getScore(entryId)
      }
      default: {
        return false
      }
    }
  }

  private async drain() {
    if (this.isDraining) return

    this.isDraining = true
    this.publishStatus()
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, BATCH_SIZE)
        this.publishStatus()
        await this.runWithConcurrency(batch, CONCURRENCY, (job) => this.processJob(job))
      }
    } finally {
      this.isDraining = false
      this.publishStatus()
      if (this.queue.length > 0) {
        void this.drain()
      }
    }
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

  private isPending(entryId: string) {
    const startedAt = this.pendingSince.get(entryId)
    if (startedAt === undefined) return false

    if (Date.now() - startedAt >= STALE_PENDING_MS) {
      this.pendingSince.delete(entryId)
      return false
    }

    return true
  }

  private markPending(entryId: string) {
    this.pendingSince.set(entryId, Date.now())
  }

  private clearPending(entryId: string) {
    this.pendingSince.delete(entryId)
  }

  private isEntryStillSubscribed(entryId: string) {
    return Boolean(getSubscriptionByEntryId(entryId))
  }

  private isEntryCancelled(entryId: string) {
    return this.cancelledActiveEntryIds.has(entryId) || !this.isEntryStillSubscribed(entryId)
  }

  private isEntryFromFeedIds(entryId: string, feedIds: Set<string>) {
    const entry = getEntry(entryId)
    return Boolean(entry?.feedId && feedIds.has(entry.feedId))
  }

  private isSummaryGenerating(entryId: string, actionLanguage: SupportedActionLanguage) {
    const statusId = getGenerateSummaryStatusId(entryId, actionLanguage, "content")
    return useSummaryStore.getState().generatingStatus[statusId] === SummaryGeneratingStatus.Pending
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`[enrichment] Timed out after ${timeoutMs}ms: ${label}`))
        }, timeoutMs)
      }),
    ])
  }

  private async processJob(job: EnrichmentJob) {
    if (this.isEntryCancelled(job.entryId)) {
      this.clearPending(job.entryId)
      this.cancelledActiveEntryIds.delete(job.entryId)
      this.publishStatus()
      return
    }

    const startedAt = new Date().toISOString()
    this.activeJobs.set(job.entryId, {
      entryId: job.entryId,
      phase: job.phases[0] ?? null,
      startedAt,
      phases: job.phases,
    })
    this.publishStatus()

    try {
      await this.withTimeout(
        (async () => {
          for (const phase of job.phases) {
            if (this.isEntryCancelled(job.entryId)) break

            const activeJob = this.activeJobs.get(job.entryId)
            if (activeJob) {
              this.activeJobs.set(job.entryId, { ...activeJob, phase })
              this.publishStatus()
            }
            await this.runPhase(job, phase)
          }
        })(),
        JOB_TIMEOUT_MS,
        job.entryId,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown enrichment error"
      const activeJob = this.activeJobs.get(job.entryId)
      const phase = activeJob?.phase ?? job.phases[0] ?? null
      const errorCode = getEnrichmentErrorCode(message)
      console.warn("[enrichment] Failed to enrich entry:", job.entryId, error)
      this.lastError = {
        entryId: job.entryId,
        message,
        at: new Date().toISOString(),
        phase,
        errorCode,
        errorKey: buildEnrichmentErrorKey(job.entryId, errorCode),
      }
    } finally {
      this.activeJobs.delete(job.entryId)
      this.cancelledActiveEntryIds.delete(job.entryId)
      this.clearPending(job.entryId)
      this.publishStatus()
    }
  }

  private async runPhase(job: EnrichmentJob, phase: EnrichmentPhase) {
    const { entryId, actionLanguage, translationMode } = job

    switch (phase) {
      case "summary": {
        await summarySyncService.generateSummary({
          entryId,
          target: "content",
          actionLanguage,
        })
        return
      }
      case "titleTranslation": {
        await translationSyncService.generateTranslation({
          entryId,
          language: actionLanguage,
          target: "content",
          withContent: false,
          mode: translationMode,
          fields: ["title"],
        })
        return
      }
      case "tags": {
        await entryAiTagsSyncService.generateTags({
          entryId,
          actionLanguage,
        })
        return
      }
      case "qualityScore": {
        await entryQualityScoreSyncService.generateScore({
          entryId,
          actionLanguage,
        })
        return
      }
      default: {
        return
      }
    }
  }
}

export const entryEnrichmentService = new EntryEnrichmentService()
