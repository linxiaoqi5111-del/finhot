/**
 * Hotword Engine — tracks term frequency over time and detects bursts.
 *
 * Architecture:
 * - Processes entry text (title + description) through segmenter
 * - Maintains per-term frequency counters in time windows
 * - Detects "bursts" when current frequency exceeds historical baseline
 * - Stores hotword snapshots in SQLite for time-series visualization
 */

import { DEFAULT_ADMISSION_THRESHOLD, filterByAdmission } from "./admission"
import { segmentText } from "./segmenter"

/** A single term frequency record */
export interface TermFrequency {
  term: string
  count: number
  /** Burst score: ratio of current frequency to historical baseline */
  burstScore: number
  /** Whether this term is currently "bursting" (score > threshold) */
  isBurst: boolean
  /** First seen timestamp in current window */
  firstSeen: number
  /** Last seen timestamp in current window */
  lastSeen: number
  /** Admission score from knowledge-base concept matching (higher = more relevant) */
  admissionScore?: number
}

/** Hotword snapshot for storage */
export interface HotwordSnapshot {
  timestamp: number
  windowMinutes: number
  terms: TermFrequency[]
}

/** A single data point for time-series visualization */
export interface TimeSeriesPoint {
  timestamp: number
  count: number
}

/** Time-series data for a single term across windows */
export interface TermTimeSeries {
  term: string
  points: TimeSeriesPoint[]
  currentCount: number
  isBurst: boolean
  burstScore: number
}

/** Configuration for the hotword engine */
export interface HotwordEngineConfig {
  /** Current time window size in minutes (default: 60) */
  windowMinutes: number
  /** Number of historical windows to keep for baseline (default: 24) */
  baselineWindows: number
  /** Burst detection threshold: current/baseline ratio (default: 3.0) */
  burstThreshold: number
  /** Minimum count to consider a term (default: 2) */
  minCount: number
  /** Maximum terms to return in a snapshot (default: 50) */
  maxTerms: number
  /** Minimum admission score to include a term (default: 2). Set to 0 to disable. */
  admissionThreshold: number
}

const DEFAULT_CONFIG: HotwordEngineConfig = {
  windowMinutes: 60,
  baselineWindows: 24,
  burstThreshold: 3,
  minCount: 3,
  maxTerms: 30,
  admissionThreshold: DEFAULT_ADMISSION_THRESHOLD,
}

/** Internal time-window counter */
interface WindowCounter {
  startTime: number
  counts: Map<string, number>
  totalDocs: number
}

/**
 * In-memory hotword engine that tracks term frequencies across time windows.
 */
export class HotwordEngine {
  private config: HotwordEngineConfig
  private currentWindow: WindowCounter
  private historicalWindows: WindowCounter[] = []
  private processedEntryIds = new Set<string>()
  /** Tracks which terms were matched via FINANCE_DICTIONARY during processing */
  private dictionaryMatchedTerms = new Set<string>()

  constructor(config?: Partial<HotwordEngineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.currentWindow = this.createWindow()
  }

  private createWindow(): WindowCounter {
    return {
      startTime: Date.now(),
      counts: new Map(),
      totalDocs: 0,
    }
  }

  private getWindowDurationMs(): number {
    return this.config.windowMinutes * 60 * 1000
  }

  /** Rotate window if current one has expired */
  private maybeRotateWindow(): void {
    const elapsed = Date.now() - this.currentWindow.startTime
    if (elapsed >= this.getWindowDurationMs()) {
      // Archive current window
      this.historicalWindows.push(this.currentWindow)

      // Trim old windows
      while (this.historicalWindows.length > this.config.baselineWindows) {
        this.historicalWindows.shift()
      }

      // Start fresh window
      this.currentWindow = this.createWindow()
    }
  }

  /**
   * Process an entry's text content and update term frequencies.
   * Deduplicates by entry ID to avoid double-counting refreshed entries.
   */
  processEntry(
    entryId: string,
    title: string | null,
    description: string | null,
    content: string | null,
  ): void {
    if (this.processedEntryIds.has(entryId)) return
    this.processedEntryIds.add(entryId)

    // Limit dedup set size
    if (this.processedEntryIds.size > 10000) {
      const entries = [...this.processedEntryIds]
      this.processedEntryIds = new Set(entries.slice(-5000))
    }

    this.maybeRotateWindow()

    // Combine text fields for analysis
    const text = [title, description, content].filter(Boolean).join(" ")
    if (!text.trim()) return

    const { terms, dictionaryMatches } = segmentText(text)

    for (const dm of dictionaryMatches) {
      this.dictionaryMatchedTerms.add(dm)
    }

    this.currentWindow.totalDocs++
    for (const term of terms) {
      const prev = this.currentWindow.counts.get(term) ?? 0
      this.currentWindow.counts.set(term, prev + 1)
    }
  }

  /**
   * Compute historical baseline average frequency for a term.
   */
  private getBaseline(term: string): number {
    if (this.historicalWindows.length === 0) return 0

    let totalCount = 0
    for (const window of this.historicalWindows) {
      totalCount += window.counts.get(term) ?? 0
    }
    return totalCount / this.historicalWindows.length
  }

  /**
   * Get current hotword rankings with burst detection.
   */
  getSnapshot(): HotwordSnapshot {
    this.maybeRotateWindow()

    const terms: TermFrequency[] = []
    const now = Date.now()

    for (const [term, count] of this.currentWindow.counts) {
      if (count < this.config.minCount) continue

      const baseline = this.getBaseline(term)
      // Burst score: how much current frequency exceeds baseline
      // If no baseline yet (first window), use count as raw score
      const burstScore = baseline > 0 ? count / baseline : count

      terms.push({
        term,
        count,
        burstScore,
        isBurst: burstScore >= this.config.burstThreshold,
        firstSeen: this.currentWindow.startTime,
        lastSeen: now,
      })
    }

    // Apply admission scoring: filter through knowledge-base concept matching
    const admitted =
      this.config.admissionThreshold > 0
        ? filterByAdmission(terms, this.dictionaryMatchedTerms, this.config.admissionThreshold)
        : terms.map((t) => ({ ...t, admissionScore: 0 }))

    // Sort: admission score > burst > count
    admitted.sort((a, b) => {
      const aScore = a.admissionScore ?? 0
      const bScore = b.admissionScore ?? 0
      if (aScore !== bScore) return bScore - aScore
      if (a.isBurst !== b.isBurst) return a.isBurst ? -1 : 1
      if (a.burstScore !== b.burstScore) return b.burstScore - a.burstScore
      return b.count - a.count
    })

    return {
      timestamp: now,
      windowMinutes: this.config.windowMinutes,
      terms: admitted.slice(0, this.config.maxTerms),
    }
  }

  /** Get only bursting terms */
  getBurstingTerms(): TermFrequency[] {
    return this.getSnapshot().terms.filter((t) => t.isBurst)
  }

  /** Get top N terms by frequency */
  getTopTerms(n = 20): TermFrequency[] {
    const snapshot = this.getSnapshot()
    return [...snapshot.terms].sort((a, b) => b.count - a.count).slice(0, n)
  }

  /** Reset all state */
  reset(): void {
    this.currentWindow = this.createWindow()
    this.historicalWindows = []
    this.processedEntryIds.clear()
    this.dictionaryMatchedTerms.clear()
  }

  /** Get engine stats */
  getStats(): {
    currentWindowDocs: number
    historicalWindows: number
    uniqueTerms: number
    processedEntries: number
  } {
    return {
      currentWindowDocs: this.currentWindow.totalDocs,
      historicalWindows: this.historicalWindows.length,
      uniqueTerms: this.currentWindow.counts.size,
      processedEntries: this.processedEntryIds.size,
    }
  }

  /**
   * Get time-series data for top terms across all windows.
   * Returns frequency counts per window for trend visualization.
   */
  getTimeSeries(topN = 10): TermTimeSeries[] {
    const snapshot = this.getSnapshot()
    const topTerms = [...snapshot.terms].sort((a, b) => b.count - a.count).slice(0, topN)

    return topTerms.map((termFreq) => {
      const points: TimeSeriesPoint[] = []

      // Historical windows
      for (const window of this.historicalWindows) {
        points.push({
          timestamp: window.startTime,
          count: window.counts.get(termFreq.term) ?? 0,
        })
      }

      // Current window
      points.push({
        timestamp: this.currentWindow.startTime,
        count: this.currentWindow.counts.get(termFreq.term) ?? 0,
      })

      return {
        term: termFreq.term,
        points,
        currentCount: termFreq.count,
        isBurst: termFreq.isBurst,
        burstScore: termFreq.burstScore,
      }
    })
  }

  /** Get all terms with counts above threshold, grouped for dashboard display */
  getDashboardData(): {
    bursting: TermFrequency[]
    trending: TermFrequency[]
    stable: TermFrequency[]
    totalArticles: number
    totalTerms: number
  } {
    const snapshot = this.getSnapshot()
    const bursting: TermFrequency[] = []
    const trending: TermFrequency[] = []
    const stable: TermFrequency[] = []

    for (const term of snapshot.terms) {
      if (term.isBurst) {
        bursting.push(term)
      } else if (term.burstScore > 1.5) {
        trending.push(term)
      } else {
        stable.push(term)
      }
    }

    let totalArticles = this.currentWindow.totalDocs
    for (const w of this.historicalWindows) {
      totalArticles += w.totalDocs
    }

    return {
      bursting,
      trending,
      stable,
      totalArticles,
      totalTerms: this.currentWindow.counts.size,
    }
  }
}
