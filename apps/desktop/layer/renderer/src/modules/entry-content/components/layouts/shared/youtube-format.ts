export interface YouTubeTranscriptCue {
  id: string
  time: string
  seconds: number
  text: string
}

export interface YouTubeChapter {
  time: string
  seconds: number
  title: string
}

export type YouTubeContentBlock =
  | {
      type: "paragraph"
      text: string
    }
  | {
      type: "chapters"
      items: YouTubeChapter[]
    }

interface ParsedTime {
  seconds: number
  time: string
}

interface TranscriptLine {
  time: ParsedTime
  text?: string
}

const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g
const CHAPTER_MARKER_REGEX = /(^|\s)(\d{1,2}:[0-5]\d(?::[0-5]\d)?)\s*[-–]\s*/g

export function secondsToYouTubeTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const secs = totalSeconds % 60

  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }

  return `${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
}

export function parseYouTubeTime(value: string): ParsedTime | null {
  const normalized = value.trim()

  if (/^\d+$/.test(normalized)) {
    const seconds = Number.parseInt(normalized, 10)
    return Number.isFinite(seconds) ? { seconds, time: secondsToYouTubeTime(seconds) } : null
  }

  const parts = normalized.split(":").map((part) => Number.parseInt(part, 10))
  if (parts.some((part) => Number.isNaN(part))) return null

  if (parts.length === 2) {
    const [minutes, seconds] = parts
    if (minutes === undefined || seconds === undefined || seconds > 59) return null
    const totalSeconds = minutes * 60 + seconds
    return { seconds: totalSeconds, time: secondsToYouTubeTime(totalSeconds) }
  }

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts
    if (
      hours === undefined ||
      minutes === undefined ||
      seconds === undefined ||
      minutes > 59 ||
      seconds > 59
    ) {
      return null
    }

    const totalSeconds = hours * 3600 + minutes * 60 + seconds
    return { seconds: totalSeconds, time: secondsToYouTubeTime(totalSeconds) }
  }

  return null
}

export function parseYouTubeTranscript(content: string): YouTubeTranscriptCue[] {
  const lines = normalizeText(content).split("\n")
  const cues: YouTubeTranscriptCue[] = []
  let pendingTime: ParsedTime | null = null

  const appendCueText = (time: ParsedTime, rawText: string) => {
    const text = cleanupTranscriptText(rawText)
    if (!text) return

    const lastCue = cues.at(-1)
    if (lastCue?.seconds === time.seconds) {
      lastCue.text = normalizeSpaces(`${lastCue.text} ${text}`)
      return
    }

    cues.push({
      id: `${time.seconds}-${cues.length}`,
      time: time.time,
      seconds: time.seconds,
      text,
    })
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    if (isIgnoredTranscriptHeading(line)) continue

    const parsedLine = parseTranscriptLine(line)
    if (parsedLine) {
      if (parsedLine.text) {
        appendCueText(parsedLine.time, parsedLine.text)
        pendingTime = null
      } else {
        pendingTime = parsedLine.time
      }
      continue
    }

    const text = cleanupTranscriptText(line)
    if (!text) continue

    if (pendingTime) {
      appendCueText(pendingTime, text)
      pendingTime = null
      continue
    }

    const lastCue = cues.at(-1)
    if (lastCue && !isMarkdownHeading(line)) {
      lastCue.text = normalizeSpaces(`${lastCue.text} ${text}`)
    }
  }

  return cues
}

export function parseYouTubeContent(content: string): YouTubeContentBlock[] {
  const lines = normalizeDescriptionText(content).split("\n")
  const blocks: YouTubeContentBlock[] = []
  let paragraphLines: string[] = []
  let chapters: YouTubeChapter[] = []

  const flushParagraph = () => {
    const text = paragraphLines.join("\n").trim()
    if (text) {
      blocks.push({
        type: "paragraph",
        text,
      })
    }
    paragraphLines = []
  }

  const flushChapters = () => {
    if (chapters.length > 0) {
      blocks.push({
        type: "chapters",
        items: chapters,
      })
    }
    chapters = []
  }

  const addParagraphLine = (line: string) => {
    flushChapters()
    paragraphLines.push(line)
  }

  const addChapters = (items: YouTubeChapter[]) => {
    flushParagraph()
    chapters.push(...items)
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (!line) {
      flushParagraph()
      flushChapters()
      continue
    }

    const chapterSection = extractChapterSection(line)
    if (!chapterSection) {
      addParagraphLine(line)
      continue
    }

    if (chapterSection.prefix) {
      addParagraphLine(chapterSection.prefix)
    }
    addChapters(chapterSection.items)
  }

  flushParagraph()
  flushChapters()

  return blocks
}

function parseTranscriptLine(line: string): TranscriptLine | null {
  const possibleBoldLine = line.trim().replace(/^[-*+]\s+/, "")
  if (possibleBoldLine.startsWith("**")) {
    const boldEndIndex = possibleBoldLine.indexOf("**", 2)
    if (boldEndIndex > 2) {
      const time = parseYouTubeTime(possibleBoldLine.slice(2, boldEndIndex))
      if (time) {
        const text = possibleBoldLine.slice(boldEndIndex + 2).trim()
        return {
          time,
          text: text || undefined,
        }
      }
    }
  }

  const cleanLine = stripMarkdownDecorators(line)
  const timeOnly = cleanLine.match(/^(\d+(?::[0-5]\d){0,2})$/)
  if (timeOnly?.[1]) {
    const time = parseYouTubeTime(timeOnly[1])
    return time ? { time } : null
  }

  const firstSpaceIndex = cleanLine.search(/\s/)
  if (firstSpaceIndex > 0) {
    const timeValue = cleanLine.slice(0, firstSpaceIndex)
    const text = cleanLine.slice(firstSpaceIndex + 1).trim()
    const time = /^\d{1,2}:[0-5]\d(?::[0-5]\d)?$/.test(timeValue)
      ? parseYouTubeTime(timeValue)
      : null

    if (!time || !text) return null

    return {
      time,
      text,
    }
  }

  return null
}

function extractChapterSection(line: string) {
  const matches = [...line.matchAll(CHAPTER_MARKER_REGEX)]
  if (matches.length === 0) return null

  const firstMatch = matches[0]
  if (!firstMatch?.[2] || firstMatch.index === undefined) return null

  const firstStart = firstMatch.index + firstMatch[1]!.length
  if (firstStart > 0 && matches.length < 2) return null

  const items = matches
    .map((match, index): YouTubeChapter | null => {
      const timeValue = match[2]
      if (!timeValue || match.index === undefined) return null

      const time = parseYouTubeTime(timeValue)
      if (!time) return null

      const titleStart = match.index + match[0].length
      const nextMatch = matches[index + 1]
      const titleEnd =
        nextMatch?.index === undefined ? line.length : nextMatch.index + nextMatch[1]!.length
      const title = normalizeSpaces(line.slice(titleStart, titleEnd))

      if (!title) return null

      return {
        time: time.time,
        seconds: time.seconds,
        title,
      }
    })
    .filter((item): item is YouTubeChapter => item !== null)

  if (items.length === 0) return null

  return {
    prefix: line.slice(0, firstStart).trim(),
    items,
  }
}

function normalizeDescriptionText(content: string): string {
  return decodeHtmlEntities(content)
    .replaceAll(/<br\s*\/?>/gi, "\n")
    .replaceAll(/<\/p>/gi, "\n\n")
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll(/\r\n?/g, "\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim()
}

function normalizeText(content: string): string {
  return decodeHtmlEntities(content)
    .replaceAll(/\r\n?/g, "\n")
    .replaceAll(MARKDOWN_LINK_REGEX, "$1 $2")
    .trim()
}

function decodeHtmlEntities(content: string): string {
  return content
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
}

function isIgnoredTranscriptHeading(line: string): boolean {
  const cleanLine = stripMarkdownDecorators(line).toLowerCase()
  if (!cleanLine) return true

  return cleanLine === "transcript" || cleanLine === "transcription"
}

function isMarkdownHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(line.trim())
}

function stripMarkdownDecorators(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\u00b7\s+/, "")
    .replace(/^>\s+/, "")
    .replaceAll(/\*\*([^*]+)\*\*/g, "$1")
    .replaceAll(/__([^_]+)__/g, "$1")
    .replaceAll(/`([^`]+)`/g, "$1")
    .trim()
}

function cleanupTranscriptText(text: string): string {
  return normalizeSpaces(stripMarkdownDecorators(text))
}

function normalizeSpaces(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim()
}
