import {
  isYouTubeWatchUrl,
  normalizeYouTubeWatchUrl,
  resolveYouTubeWatchUrl,
} from "@follow/utils/url-for-video"
import { Defuddle } from "defuddle/node"
import { parseHTML } from "linkedom"

export interface YouTubeDefuddleResult {
  content: string
  title: string | null
}

const TRANSCRIPT_MARKERS = [/##\s*Transcript/i, /\*\*\d+:\d+(?::\d+)?\*\*/]

export const hasYouTubeTranscriptContent = (content: string | null | undefined) => {
  if (!content?.trim()) return false
  const normalized = content.trim()
  return TRANSCRIPT_MARKERS.some((pattern) => pattern.test(normalized))
}

const mapLanguageCandidates = (language?: string) => {
  const candidates = new Set<string>()

  if (language && language !== "default") {
    candidates.add(language)
    if (language.startsWith("zh")) {
      candidates.add("zh-CN")
      candidates.add("zh")
    }
  }

  candidates.add("en")
  candidates.add("en-US")

  return [...candidates]
}

const fetchWithLanguage = async (url: string, language: string) => {
  const { document } = parseHTML("<html><head></head><body></body></html>")
  return Defuddle(document, url, {
    markdown: true,
    useAsync: true,
    language,
  })
}

export async function fetchYouTubeDefuddle(
  input: {
    url?: string | null
    guid?: string | null
  },
  language?: string,
): Promise<YouTubeDefuddleResult | null> {
  const watchUrl =
    resolveYouTubeWatchUrl(input) ?? (input.url ? normalizeYouTubeWatchUrl(input.url) : null)
  if (!watchUrl || !isYouTubeWatchUrl(watchUrl)) {
    return null
  }

  const languages = mapLanguageCandidates(language)

  for (const candidate of languages) {
    try {
      const result = await fetchWithLanguage(watchUrl, candidate)
      const content = (result.contentMarkdown ?? result.content)?.trim()

      if (!hasYouTubeTranscriptContent(content)) {
        continue
      }

      return {
        content: content!,
        title: result.title?.trim() || null,
      }
    } catch (error) {
      console.error(`YouTube Defuddle failed for language ${candidate}`, error)
    }
  }

  return null
}
