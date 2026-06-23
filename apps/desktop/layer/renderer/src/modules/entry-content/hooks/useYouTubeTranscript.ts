import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { isYouTubeWatchUrl } from "@follow/utils/url-for-video"
import { useQuery } from "@tanstack/react-query"

import { useActionLanguage } from "~/atoms/settings/general"
import { ipcServices } from "~/lib/client"

export const useYouTubeTranscript = (entryId: string, url?: string | null) => {
  const actionLanguage = useActionLanguage()

  return useQuery({
    queryKey: ["youtube-transcript", entryId, url, actionLanguage],
    enabled: LOCAL_RSS_MODE && !!url && isYouTubeWatchUrl(url),
    queryFn: async () => {
      if (!url || !ipcServices?.reader?.youtubeDefuddle) {
        return null
      }

      const result = await ipcServices.reader.youtubeDefuddle({
        url,
        language: actionLanguage,
      })

      return result?.content?.trim() || null
    },
    staleTime: 1000 * 60 * 60 * 24,
    retry: 1,
  })
}
