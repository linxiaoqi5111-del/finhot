import { getEntry } from "@follow/store/entry/getter"

import type { AIChatContextBlock, BizUIMessage } from "./types"

type OpenAIChatRole = "system" | "user" | "assistant"

export interface OpenAIChatMessage {
  role: OpenAIChatRole
  content: string
}

const MAX_ENTRY_CONTEXT_CHARS = 12_000

const htmlToText = (content: string) => {
  if (!content.trim()) return ""

  if (typeof DOMParser !== "undefined") {
    const document = new DOMParser().parseFromString(content, "text/html")
    return document.body.textContent?.replaceAll(/\s+/g, " ").trim() ?? ""
  }

  return content
    .replaceAll(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replaceAll(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
}

const truncateEntryContext = (content: string) => {
  if (content.length <= MAX_ENTRY_CONTEXT_CHARS) return content
  return `${content.slice(0, MAX_ENTRY_CONTEXT_CHARS)}\n\n[Article context truncated]`
}

const getEntryContextText = (entryId: string) => {
  const entry = getEntry(entryId)
  if (!entry) return ""

  const content = htmlToText(entry.readabilityContent || entry.content || "")
  const parts = [
    "Current article context:",
    entry.title ? `Title: ${entry.title}` : "",
    entry.url ? `URL: ${entry.url}` : "",
    content ? `Content:\n${truncateEntryContext(content)}` : "",
  ].filter(Boolean)

  return parts.join("\n")
}

const extractContextText = (message: BizUIMessage) => {
  const blocks = message.parts.flatMap((part): AIChatContextBlock[] => {
    if (part.type !== "data-block") return []
    return part.data
  })

  return blocks
    .map((block) => {
      if (block.disabled) return ""
      if (block.type === "mainEntry") return getEntryContextText(block.value)
      return ""
    })
    .filter(Boolean)
    .join("\n\n")
}

const extractMessageText = (message: BizUIMessage) => {
  const text = message.parts
    .map((part) => {
      if (part.type === "text") return part.text
      if (part.type === "data-rich-text") return part.data.text
      return ""
    })
    .filter(Boolean)
    .join("\n")

  const context = extractContextText(message)
  return [context, text].filter(Boolean).join("\n\nUser question:\n")
}

export const toOpenAIChatMessages = (messages: BizUIMessage[]): OpenAIChatMessage[] => {
  return messages
    .map((message): OpenAIChatMessage | null => {
      if (!["system", "user", "assistant"].includes(message.role)) return null

      const content = extractMessageText(message)
      if (!content.trim()) return null

      return {
        role: message.role as OpenAIChatRole,
        content,
      }
    })
    .filter((message): message is OpenAIChatMessage => !!message)
}
