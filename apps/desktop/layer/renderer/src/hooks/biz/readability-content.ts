import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { getEntry } from "@follow/store/entry/getter"
import { isYouTubeWatchUrl } from "@follow/utils/url-for-video"

import { ipcServices } from "~/lib/client"

const fetchYouTubeTranscriptContent = async (url: string) => {
  const result = await ipcServices?.reader.youtubeDefuddle({ url })
  return result?.content ?? null
}

export const fetchEntryReadabilityContentFromSource = async ({
  id,
  url,
}: {
  id: string
  url: string
}) => {
  if (LOCAL_RSS_MODE && isYouTubeWatchUrl(url)) {
    try {
      const transcript = await fetchYouTubeTranscriptContent(url)
      if (transcript) {
        return transcript
      }
    } catch {
      // Fall through to RSS content fallback.
    }
  }

  try {
    const result = await ipcServices?.reader.readability({ url })
    if (result?.content) {
      return result.content
    }
  } catch (error) {
    if (!LOCAL_RSS_MODE) {
      throw error
    }
  }

  if (!LOCAL_RSS_MODE) {
    return null
  }

  const entry = getEntry(id)
  return entry?.content || entry?.description
}
