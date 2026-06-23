import { useCallback } from "react"

import { entryEnrichmentService } from "../enrichment/service"
import { useEntryStore } from "../entry/store"
import { getQualityScoreCoverageStats } from "./backlog"
import { useEntryQualityScoreStore } from "./store"

export const useEntryQualityScore = (entryId: string) => {
  return useEntryQualityScoreStore(useCallback((state) => state.data[entryId], [entryId]))
}

export const useQualityScoreCoverageStats = () => {
  useEntryStore((state) => state.data)
  useEntryQualityScoreStore((state) => state.data)

  return getQualityScoreCoverageStats((entryId) =>
    entryEnrichmentService.isEntryInPipeline(entryId),
  )
}
