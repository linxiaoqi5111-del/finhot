import { createZustandStore } from "../../lib/helper"
import type { EnrichmentErrorCode } from "./error-utils"
import type { EnrichmentPhase } from "./types"

export type EnrichmentActiveJob = {
  entryId: string
  phase: EnrichmentPhase | null
  startedAt: string
  phases: readonly EnrichmentPhase[]
}

export type EnrichmentStatusSnapshot = {
  queueLength: number
  pendingCount: number
  isProcessing: boolean
  activeJobs: EnrichmentActiveJob[]
  lastError: {
    entryId: string
    message: string
    at: string
    phase: EnrichmentPhase | null
    errorCode: EnrichmentErrorCode
    errorKey: string
  } | null
  updatedAt: string
}

const idleSnapshot = (): EnrichmentStatusSnapshot => ({
  queueLength: 0,
  pendingCount: 0,
  isProcessing: false,
  activeJobs: [],
  lastError: null,
  updatedAt: new Date().toISOString(),
})

interface EnrichmentStatusState {
  snapshot: EnrichmentStatusSnapshot
}

export const useEnrichmentStatusStore = createZustandStore<EnrichmentStatusState>(
  "enrichment-status",
)(() => ({
  snapshot: idleSnapshot(),
}))

class EnrichmentStatusActions {
  setSnapshot(snapshot: Omit<EnrichmentStatusSnapshot, "updatedAt">) {
    useEnrichmentStatusStore.setState({
      snapshot: {
        ...snapshot,
        updatedAt: new Date().toISOString(),
      },
    })
  }

  reset() {
    useEnrichmentStatusStore.setState({ snapshot: idleSnapshot() })
  }
}

export const enrichmentStatusActions = new EnrichmentStatusActions()
