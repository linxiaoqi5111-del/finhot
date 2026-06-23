import type { IpcContext } from "electron-ipc-decorator"
import { IpcMethod, IpcService } from "electron-ipc-decorator"

interface OpenAICompatibleChatCompletionInput {
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  body: Record<string, unknown>
}

interface OpenAICompatibleEmbeddingInput {
  baseURL: string
  apiKey: string
  body: Record<string, unknown>
}

const normalizeOpenAIBaseURL = (baseURL: string) => baseURL.replace(/\/+$/, "")

const toReadableErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return String(error)
}

export class AiService extends IpcService {
  static override readonly groupName = "ai"

  @IpcMethod()
  async openAICompatibleChatCompletion(
    _context: IpcContext,
    input: OpenAICompatibleChatCompletionInput,
  ): Promise<unknown> {
    const endpoint = `${normalizeOpenAIBaseURL(input.baseURL)}/chat/completions`
    const url = new URL(endpoint)

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("BYOK provider Base URL must use http or https.")
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
          "Content-Type": "application/json",
          ...input.headers,
        },
        body: JSON.stringify(input.body),
      })
    } catch (error) {
      throw new Error(
        `Failed to reach BYOK provider at ${url.origin}. Check the Base URL, network, or proxy settings. ${toReadableErrorMessage(error)}`,
      )
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      throw new Error(errorText || `BYOK provider request failed with HTTP ${response.status}.`)
    }

    return response.json()
  }

  @IpcMethod()
  async openAICompatibleEmbedding(
    _context: IpcContext,
    input: OpenAICompatibleEmbeddingInput,
  ): Promise<unknown> {
    const endpoint = `${normalizeOpenAIBaseURL(input.baseURL)}/embeddings`
    const url = new URL(endpoint)

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Embedding provider Base URL must use http or https.")
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input.body),
      })
    } catch (error) {
      throw new Error(
        `Failed to reach embedding provider at ${url.origin}. Check the Base URL, network, or proxy settings. ${toReadableErrorMessage(error)}`,
      )
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      throw new Error(
        errorText || `Embedding provider request failed with HTTP ${response.status}.`,
      )
    }

    return response.json()
  }
}
