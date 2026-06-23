import { IN_ELECTRON } from "@follow/shared/constants"
import { resolveYouTubeWatchUrl } from "@follow/utils/url-for-video"

import { ipcServices } from "~/lib/client"

export const fetchYouTubeTranscript = async ({
  url,
  guid,
  language,
}: {
  url?: string | null
  guid?: string | null
  language?: string
}) => {
  const watchUrl = resolveYouTubeWatchUrl({ url, guid })
  if (!watchUrl) {
    return null
  }

  if (!IN_ELECTRON) {
    console.warn("YouTube transcript requires the Electron app runtime")
    return null
  }

  if (!ipcServices?.reader?.youtubeDefuddle) {
    console.warn("YouTube transcript IPC is unavailable. Restart the Electron app.")
    return null
  }

  try {
    const result = await ipcServices.reader.youtubeDefuddle({
      url: watchUrl,
      guid: guid ?? undefined,
      language,
    })

    return result?.content?.trim() || null
  } catch (error) {
    console.error("Failed to fetch YouTube transcript", error)
    throw error
  }
}
