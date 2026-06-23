import { createZustandStore } from "../../lib/helper"

export type EmbeddingJobActiveJob = {
  entryId: string
  startedAt: string
}

export type EmbeddingJobStatusSnapshot = {
  queueLength: number
  pendingCount: number
  isProcessing: boolean
  activeJobs: EmbeddingJobActiveJob[]
  lastError: {
    entryId: string
    message: string
    at: string
  } | null
  backlogCount: number
  coveredCount: number
  eligibleCount: number
  updatedAt: string
}

const idleSnapshot = (): EmbeddingJobStatusSnapshot => ({
  queueLength: 0,
  pendingCount: 0,
  isProcessing: false,
  activeJobs: [],
  lastError: null,
  backlogCount: 0,
  coveredCount: 0,
  eligibleCount: 0,
  updatedAt: new Date().toISOString(),
})

interface EmbeddingJobStatusState {
  snapshot: EmbeddingJobStatusSnapshot
}

export const useEmbeddingJobStatusStore = createZustandStore<EmbeddingJobStatusState>(
  "embedding-job-status",
)(() => ({
  snapshot: idleSnapshot(),
}))

class EmbeddingJobStatusActions {
  setSnapshot(snapshot: Omit<EmbeddingJobStatusSnapshot, "updatedAt">) {
    useEmbeddingJobStatusStore.setState({
      snapshot: {
        ...snapshot,
        updatedAt: new Date().toISOString(),
      },
    })
  }

  reset() {
    useEmbeddingJobStatusStore.setState({ snapshot: idleSnapshot() })
  }
}

export const embeddingJobStatusActions = new EmbeddingJobStatusActions()
