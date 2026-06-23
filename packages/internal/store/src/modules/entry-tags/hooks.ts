import { useCallback } from "react"

import { useEntryAiTagsStore } from "./store"

export const useEntryAiTags = (entryId: string) => {
  return useEntryAiTagsStore(useCallback((state) => state.data[entryId], [entryId]))
}

export const useEntryContentType = (entryId: string) => {
  return useEntryAiTagsStore(useCallback((state) => state.contentType[entryId], [entryId]))
}
