import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { env } from "@follow/shared/env.desktop"
import type { ChatTransport, HttpChatTransportInitOptions, UIMessageChunk } from "ai"
import { HttpChatTransport, parseJsonEventStream, uiMessageChunkSchema } from "ai"

import { getAISettings } from "~/atoms/settings/ai"
import {
  getProviderOption,
  resolveConfiguredByokProvider,
} from "~/modules/settings/tabs/ai/byok/constants"

import { getAIModelState } from "../atoms/session"
import { AIPersistService } from "../services"
import { toOpenAIChatMessages } from "./local-byok-context"
import type { BizUIMessage, BizUIMetadata } from "./types"

type TitleHandlerPersistOption = boolean | ((title: string) => void | Promise<void>)

export interface TitleHandlerOptions {
  chatId?: string
  shouldHandle?: () => boolean
  onTitleChange?: (title: string) => void
  persist?: TitleHandlerPersistOption
}

export interface CreateChatTransportOptions {
  onValue?: (value: UIMessageChunk) => void
  titleHandler?: TitleHandlerOptions
}

export interface CreateChatTitleHandlerOptions {
  chatId: string
  getActiveChatId: () => string | null | undefined
  onTitleChange?: (title: string) => void
  persist?: TitleHandlerPersistOption
}

export function createChatTitleHandler(
  options: CreateChatTitleHandlerOptions,
): TitleHandlerOptions {
  const { chatId, getActiveChatId, onTitleChange, persist } = options

  return {
    chatId,
    persist,
    onTitleChange,
    shouldHandle: () => getActiveChatId() === chatId,
  }
}

/**
 * Create a chat transport for AI SDK
 * This is used by the AbstractChat instance to communicate with AI providers
 */
export function createChatTransport({ onValue, titleHandler }: CreateChatTransportOptions = {}) {
  if (LOCAL_RSS_MODE) {
    return new LocalByokChatTransport({
      onValue,
      titleHandler,
    })
  }

  return new ExtendChatTransport({
    onValue,
    titleHandler,
    // Custom fetch configuration
    api: `${env.VITE_API_URL}/ai/chat`,
    credentials: "include",
    // Add selected model to request body
    body: () => {
      const modelState = getAIModelState()
      const { selectedModel } = modelState

      return selectedModel ? { model: selectedModel } : {}
    },
  })
}

interface OpenAIChatCompletionChunk {
  choices?: {
    delta?: {
      content?: string
    }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

const normalizeOpenAIBaseURL = (baseURL: string) => baseURL.replace(/\/+$/, "")

const toReadableErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return String(error)
}

const normalizeFinishReason = (finishReason: string | null | undefined) => {
  switch (finishReason) {
    case "stop":
    case "length": {
      return finishReason
    }
    case "content_filter": {
      return "content-filter"
    }
    case "tool_calls": {
      return "tool-calls"
    }
    default: {
      return "stop"
    }
  }
}

class LocalByokChatTransport implements ChatTransport<BizUIMessage> {
  constructor(
    private options: {
      onValue?: (value: UIMessageChunk) => void
      titleHandler?: TitleHandlerOptions
    },
  ) {}

  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<ChatTransport<BizUIMessage>["sendMessages"]>[0]) {
    const { selectedModel } = getAIModelState()
    const resolvedProvider = resolveConfiguredByokProvider(getAISettings().byok, selectedModel)

    if (!resolvedProvider) {
      throw new Error(
        "No OpenAI-compatible BYOK provider is configured. Enable BYOK and add a provider in Settings > AI.",
      )
    }

    const providerOption = getProviderOption(resolvedProvider.provider.provider)
    if (!providerOption) {
      throw new Error("The selected BYOK provider is not supported.")
    }

    const chatMessages = toOpenAIChatMessages(messages)
    if (chatMessages.length === 0) {
      throw new Error("No text message is available for the local BYOK request.")
    }

    const startedAt = Date.now()
    const metadataBase: BizUIMetadata = {
      providerType: "byok",
      provider: resolvedProvider.providerLabel,
      modelUsed: resolvedProvider.model,
    }

    const endpoint = `${normalizeOpenAIBaseURL(resolvedProvider.baseURL)}/chat/completions`
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          ...(resolvedProvider.apiKey
            ? { Authorization: `Bearer ${resolvedProvider.apiKey}` }
            : {}),
          "Content-Type": "application/json",
          ...resolvedProvider.provider.headers,
        },
        body: JSON.stringify({
          model: resolvedProvider.model,
          messages: chatMessages,
          stream: true,
        }),
        signal: abortSignal,
      })
    } catch (error) {
      throw new Error(
        `Failed to reach BYOK provider at ${resolvedProvider.baseURL}. Check the Base URL, network, proxy, or provider CORS settings. ${toReadableErrorMessage(error)}`,
      )
    }

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => "")
      throw new Error(errorText || `BYOK provider request failed with HTTP ${response.status}.`)
    }

    return new ReadableStream<UIMessageChunk>({
      start: async (controller) => {
        const textId = crypto.randomUUID()
        let finishReason: ReturnType<typeof normalizeFinishReason> = "stop"
        let usage: OpenAIChatCompletionChunk["usage"] | undefined
        const emit = (chunk: UIMessageChunk) => {
          this.options.onValue?.(chunk)
          controller.enqueue(chunk)
        }

        emit({
          type: "start",
          messageMetadata: metadataBase,
        })
        emit({
          type: "text-start",
          id: textId,
        })

        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const events = buffer.split("\n\n")
            buffer = events.pop() ?? ""

            for (const event of events) {
              const dataLines = event
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim())

              for (const data of dataLines) {
                if (!data || data === "[DONE]") continue

                const chunk = JSON.parse(data) as OpenAIChatCompletionChunk
                usage = chunk.usage ?? usage

                const choice = chunk.choices?.[0]
                const delta = choice?.delta?.content
                if (choice?.finish_reason) {
                  finishReason = normalizeFinishReason(choice.finish_reason)
                }

                if (!delta) continue

                emit({
                  type: "text-delta",
                  id: textId,
                  delta,
                })
              }
            }
          }

          const messageMetadata: BizUIMetadata = {
            ...metadataBase,
            finishTime: new Date().toISOString(),
            duration: Date.now() - startedAt,
            contextTokens: usage?.prompt_tokens,
            outputTokens: usage?.completion_tokens,
            totalTokens: usage?.total_tokens,
          }

          emit({
            type: "text-end",
            id: textId,
          })
          emit({
            type: "finish",
            finishReason,
            messageMetadata,
          })
          controller.close()
        } catch (error) {
          controller.error(error)
        }
      },
    })
  }

  async reconnectToStream() {
    return null
  }
}

type UIMessageChunkParseResult =
  ReturnType<typeof parseJsonEventStream<UIMessageChunk>> extends ReadableStream<infer T>
    ? T
    : never

const coerceFinishChunk = (chunk: UIMessageChunkParseResult): UIMessageChunk | null => {
  const { rawValue } = chunk
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return null
  }

  if ((rawValue as { type?: unknown }).type !== "finish") {
    return null
  }

  const { finishReason, messageMetadata } = rawValue as {
    finishReason?: unknown
    messageMetadata?: unknown
  }

  return {
    type: "finish",
    finishReason: typeof finishReason === "string" ? finishReason : undefined,
    messageMetadata,
  } as UIMessageChunk
}

class ExtendChatTransport extends HttpChatTransport<BizUIMessage> {
  constructor(
    private options: HttpChatTransportInitOptions<BizUIMessage> & {
      onValue?: (value: UIMessageChunk) => void
      titleHandler?: TitleHandlerOptions
    },
  ) {
    super(options)
  }

  protected processResponseStream(
    stream: ReadableStream<Uint8Array<ArrayBufferLike>>,
  ): ReadableStream<UIMessageChunk> {
    const { onValue } = this.options || {}
    const handleGeneratedTitle = this.handleGeneratedTitle.bind(this)
    return parseJsonEventStream({
      stream,
      schema: uiMessageChunkSchema,
    }).pipeThrough(
      new TransformStream<UIMessageChunkParseResult, UIMessageChunk>({
        async transform(chunk, controller) {
          const parsedChunk = chunk.success ? chunk.value : coerceFinishChunk(chunk)
          if (!parsedChunk) {
            throw chunk.error
          }

          await handleGeneratedTitle(parsedChunk)
          onValue?.(parsedChunk)
          controller.enqueue(parsedChunk)
        },
      }),
    )
  }

  private async handleGeneratedTitle(chunk: UIMessageChunk) {
    const { titleHandler } = this.options
    if (!titleHandler) {
      return
    }

    if (chunk.type !== "data-generated-title" || typeof chunk.data !== "string") {
      return
    }

    const shouldHandle = titleHandler.shouldHandle?.() ?? true
    if (!shouldHandle) {
      return
    }

    titleHandler.onTitleChange?.(chunk.data)

    const persistOption = titleHandler.persist
    const shouldPersist = persistOption === undefined ? true : persistOption

    if (!shouldPersist) {
      return
    }

    try {
      if (typeof persistOption === "function") {
        await persistOption(chunk.data)
        return
      }

      if (titleHandler.chatId) {
        await AIPersistService.updateSessionTitle(titleHandler.chatId, chunk.data, {
          touchUpdatedAt: true,
        })
      }
    } catch (error) {
      console.error("Failed to persist generated title:", error)
    }
  }

  override reconnectToStream(
    options: Parameters<HttpChatTransport<BizUIMessage>["reconnectToStream"]>[0],
  ) {
    options.chatId = encodeURIComponent(options.chatId)
    return super.reconnectToStream(options)
  }
}
