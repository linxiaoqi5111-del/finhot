import { getEntry } from "../entry/getter"
import { getSubscriptionByEntryId } from "../subscription/getter"
import {
  entryNeedsEmbedding,
  getEmbeddingCoverageStats,
  listRebuildEligibleEntryIds,
} from "./backlog"
import { embeddingJobStatusActions } from "./status-store"
import { entryEmbeddingActions, entryEmbeddingSyncService } from "./store"

const BATCH_SIZE = 8
const CONCURRENCY = 2
const JOB_TIMEOUT_MS = 90_000
const STALE_PENDING_MS = 90_000

export type EmbeddingJobEnqueueOptions = {
  entryIds: string[]
  prepend?: boolean
}

class EntryEmbeddingJobService {
  private queue: string[] = []
  private pendingSince = new Map<string, number>()
  private activeJobs = new Map<string, { entryId: string; startedAt: string }>()
  private cancelledActiveEntryIds = new Set<string>()
  private isDraining = false
  private lastError: { entryId: string; message: string; at: string } | null = null

  enqueueFromIngest(options: EmbeddingJobEnqueueOptions) {
    this.enqueueMissing({
      ...options,
      prepend: true,
    })
  }

  backfillVisible(options: EmbeddingJobEnqueueOptions) {
    this.enqueueMissing(options)
  }

  async rebuildAll() {
    const entryIds = listRebuildEligibleEntryIds()
    if (entryIds.length === 0) return 0

    await entryEmbeddingActions.reset()
    this.enqueueMissing({ entryIds, prepend: true })
    return entryIds.length
  }

  isEntryInPipeline(entryId: string) {
    if (this.queue.includes(entryId)) return true
    if (this.activeJobs.has(entryId)) return true
    return this.isPending(entryId)
  }

  cancelEntriesByFeedIds(feedIds: string[]) {
    const feedIdSet = new Set(feedIds.filter(Boolean))
    if (feedIdSet.size === 0) return 0

    let cancelledCount = 0

    this.queue = this.queue.filter((entryId) => {
      if (!this.isEntryFromFeedIds(entryId, feedIdSet)) return true

      this.clearPending(entryId)
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

  getCoverageStats() {
    return getEmbeddingCoverageStats((entryId) => this.isEntryInPipeline(entryId))
  }

  private enqueueMissing({ entryIds, prepend = false }: EmbeddingJobEnqueueOptions) {
    const jobs = this.buildJobs(entryIds)
    if (jobs.length === 0) {
      this.publishStatus()
      return
    }

    if (prepend) {
      this.queue.unshift(...jobs)
    } else {
      this.queue.push(...jobs)
    }
    this.publishStatus()
    void this.drain()
  }

  private publishStatus() {
    const coverage = this.getCoverageStats()

    embeddingJobStatusActions.setSnapshot({
      queueLength: this.queue.length,
      pendingCount: this.pendingSince.size,
      isProcessing: this.isDraining,
      activeJobs: Array.from(this.activeJobs.values()),
      lastError: this.lastError,
      backlogCount: coverage.backlogCount,
      coveredCount: coverage.coveredCount,
      eligibleCount: coverage.eligibleCount,
    })
  }

  private buildJobs(entryIds: string[]) {
    const jobs: string[] = []
    const seenIds = new Set<string>()

    for (const entryId of entryIds) {
      if (seenIds.has(entryId)) continue
      seenIds.add(entryId)

      if (this.isPending(entryId)) continue
      if (!this.isEntryStillSubscribed(entryId)) continue
      if (!entryNeedsEmbedding(entryId)) continue

      this.markPending(entryId)
      jobs.push(entryId)
    }

    return jobs
  }

  private async drain() {
    if (this.isDraining) return

    this.isDraining = true
    this.publishStatus()
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, BATCH_SIZE)
        this.publishStatus()
        await this.runWithConcurrency(batch, CONCURRENCY, (entryId) => this.processJob(entryId))
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

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`[embedding] Timed out after ${timeoutMs}ms: ${label}`))
        }, timeoutMs)
      }),
    ])
  }

  private async processJob(entryId: string) {
    if (this.isEntryCancelled(entryId)) {
      this.clearPending(entryId)
      this.cancelledActiveEntryIds.delete(entryId)
      this.publishStatus()
      return
    }

    const startedAt = new Date().toISOString()
    this.activeJobs.set(entryId, { entryId, startedAt })
    this.publishStatus()

    try {
      await this.withTimeout(
        entryEmbeddingSyncService.generateEmbedding({ entryId }),
        JOB_TIMEOUT_MS,
        entryId,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown embedding error"
      console.warn("[embedding] Failed to embed entry:", entryId, error)
      this.lastError = {
        entryId,
        message,
        at: new Date().toISOString(),
      }
    } finally {
      this.activeJobs.delete(entryId)
      this.cancelledActiveEntryIds.delete(entryId)
      this.clearPending(entryId)
      this.publishStatus()
    }
  }
}

export const entryEmbeddingJobService = new EntryEmbeddingJobService()

export { hasEmbeddingEligibleText } from "./source-text"
