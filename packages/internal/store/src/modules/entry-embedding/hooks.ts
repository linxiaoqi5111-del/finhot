import { useEntryStore } from "../entry/store"
import { getEmbeddingCoverageStats } from "./backlog"
import { entryEmbeddingJobService } from "./job-service"
import { useEmbeddingJobStatusStore } from "./status-store"
import { useEntryEmbeddingStore } from "./store"

export const useEmbeddingJobStatus = () => useEmbeddingJobStatusStore((state) => state.snapshot)

export const useEmbeddingCoverageStats = () => {
  useEmbeddingJobStatusStore((state) => state.snapshot.updatedAt)
  useEntryStore((state) => state.data)
  useEntryEmbeddingStore((state) => state.data)

  return getEmbeddingCoverageStats((entryId) => entryEmbeddingJobService.isEntryInPipeline(entryId))
}

export const useEmbeddingProcessingBusy = () => {
  const status = useEmbeddingJobStatus()

  return (
    status.isProcessing ||
    status.queueLength > 0 ||
    status.pendingCount > 0 ||
    status.activeJobs.length > 0
  )
}
