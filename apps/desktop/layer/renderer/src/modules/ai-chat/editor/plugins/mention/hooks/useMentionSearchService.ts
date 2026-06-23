import { useMemo } from "react"

import { useFeedEntrySearchService } from "~/modules/ai-chat/hooks/useFeedEntrySearchService"

import type { MentionData, MentionType } from "../types"
import { getMentionTextValue } from "../utils/mentionTextValue"

/**
 * Hook that provides search functionality for mentions
 * Uses the shared feed/entry search service
 */
export const useMentionSearchService = () => {
  const { search } = useFeedEntrySearchService()

  const searchMentions = useMemo(() => {
    return async (
      query: string,
      type?: MentionType,
      maxSuggestions = 10,
    ): Promise<MentionData[]> => {
      const trimmedQuery = query.trim()
      const results: MentionData[] = []
      const seen = new Set<string>()

      const pushResult = (mention: MentionData) => {
        const key = `${mention.type}:${String(mention.value)}`
        if (!seen.has(key)) {
          seen.add(key)
          results.push(mention)
        }
      }

      if (type && type !== "entry") {
        return results
      }

      if (type === "entry") {
        const searchResults = search(trimmedQuery, "entry", maxSuggestions)
        searchResults.forEach((item) =>
          pushResult({
            id: item.id,
            name: item.title,
            type: "entry",
            value: item.id,
            text: getMentionTextValue({
              type: "entry",
              value: item.id,
            }),
          }),
        )
        return results
      }

      const searchResults = search(trimmedQuery, "entry", maxSuggestions)
      searchResults.forEach((item) =>
        pushResult({
          id: item.id,
          name: item.title,
          type: "entry",
          value: item.id,
          text: getMentionTextValue({
            type: "entry",
            value: item.id,
          }),
        }),
      )

      return results
    }
  }, [search])

  return { searchMentions }
}
