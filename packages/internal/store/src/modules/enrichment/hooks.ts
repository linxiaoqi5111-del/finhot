import { useEmbeddingProcessingBusy } from "../entry-embedding/hooks"
import { SummaryGeneratingStatus } from "../summary/enum"
import { useSummaryStore } from "../summary/store"
import { useEnrichmentStatusStore } from "./store"

export const useEnrichmentStatus = () => useEnrichmentStatusStore((state) => state.snapshot)

export { useEmbeddingJobStatus, useEmbeddingProcessingBusy } from "../entry-embedding/hooks"

export const useSummaryGeneratingCount = () =>
  useSummaryStore(
    (state) =>
      Object.values(state.generatingStatus).filter(
        (status) => status === SummaryGeneratingStatus.Pending,
      ).length,
  )

export const useByokProcessingBusy = () => {
  const status = useEnrichmentStatus()
  const summaryGeneratingCount = useSummaryGeneratingCount()

  return (
    status.isProcessing ||
    status.queueLength > 0 ||
    status.pendingCount > 0 ||
    status.activeJobs.length > 0 ||
    summaryGeneratingCount > 0
  )
}

/** @deprecated Use useByokProcessingBusy or useEmbeddingProcessingBusy instead. */
export const useBackgroundProcessingBusy = () => {
  const byokBusy = useByokProcessingBusy()
  const embeddingBusy = useEmbeddingProcessingBusy()

  return byokBusy || embeddingBusy
}
