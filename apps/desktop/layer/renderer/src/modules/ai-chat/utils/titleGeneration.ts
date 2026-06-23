import { LOCAL_RSS_MODE } from "@follow/shared/constants"

import { followClient } from "~/lib/api-client"

import { AIPersistService } from "../services"
import type { SendingUIMessage } from "../store/types"

const buildLocalTitle = (messages: SendingUIMessage[]) => {
  const text = messages
    .map((msg) =>
      msg.parts
        ?.map((part) => {
          if (part.type === "text") return part.text
          if (part.type === "data-rich-text") return part.data.text
          return ""
        })
        .join(" "),
    )
    .filter(Boolean)
    .join(" ")
    .replaceAll(/\s+/g, " ")
    .trim()

  if (!text) return null

  const title = text.slice(0, 48).trim()
  return title.length < text.length ? `${title}...` : title
}

export const generateChatTitle = async (chatId: string, messages: SendingUIMessage[]) => {
  if (LOCAL_RSS_MODE) {
    return buildLocalTitle(messages)
  }

  const relevantMessages = messages.map((msg) => {
    let content = ""
    if (msg.parts && Array.isArray(msg.parts)) {
      for (const part of msg.parts) {
        switch (part.type) {
          case "text": {
            content += `${part.text}`
            break
          }
          case "data-rich-text": {
            content += part.data.text
            break
          }
        }
      }
    }

    return {
      role: msg.role,
      content,
    }
  })

  const response = await followClient.api.ai
    .summaryTitle({
      chatId,
      messages: relevantMessages,
    })
    .catch((error) => {
      console.error("Failed to generate chat title:", error)
      return null
    })

  if (response && "title" in response) {
    return response.title
  }

  return null
}

/**
 * Generate and update chat title based on messages
 * @param chatId - Current chat session ID
 * @param messages - Messages to generate title from
 * @param onTitleUpdate - Callback when title is updated
 * @returns Generated title or null
 */
export const generateAndUpdateChatTitle = async (
  chatId: string,
  messages: SendingUIMessage[],
  onTitleUpdate?: (title: string) => void,
): Promise<string | null> => {
  if (messages.length === 0) {
    return null
  }

  const title = await generateChatTitle(chatId, messages)

  if (title && chatId) {
    try {
      await AIPersistService.updateSessionTitle(chatId, title, { touchUpdatedAt: true })
      onTitleUpdate?.(title)
      return title
    } catch (error) {
      console.error("Failed to update session title:", error)
      throw error
    }
  }

  return null
}
