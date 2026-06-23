import { useCallback } from "react"

import { useEntryRankScoreStore } from "./store"

export const useEntryRankScore = (entryId: string) => {
  return useEntryRankScoreStore(useCallback((state) => state.data[entryId], [entryId]))
}
