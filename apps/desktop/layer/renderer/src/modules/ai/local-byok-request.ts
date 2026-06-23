import { ipcServices } from "~/lib/client"

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

export interface OpenAICompatibleChatCompletionResponse {
  choices?: {
    message?: {
      content?: string | null
    }
  }[]
}

export interface OpenAICompatibleEmbeddingResponse {
  data?: Array<{
    embedding?: number[]
  }>
}

const normalizeOpenAIBaseURL = (baseURL: string) => baseURL.replace(/\/+$/, "")

const toReadableErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return String(error)
}

const fetchOpenAICompatibleChatCompletion = async ({
  baseURL,
  apiKey,
  headers,
  body,
}: OpenAICompatibleChatCompletionInput) => {
  const endpoint = `${normalizeOpenAIBaseURL(baseURL)}/chat/completions`

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new Error(
      `Failed to reach BYOK provider at ${baseURL}. Check the Base URL, network, proxy, or provider CORS settings. ${toReadableErrorMessage(error)}`,
    )
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "")
    throw new Error(errorText || `BYOK provider request failed with HTTP ${response.status}.`)
  }

  return response.json() as Promise<OpenAICompatibleChatCompletionResponse>
}

export const requestOpenAICompatibleChatCompletion = async (
  input: OpenAICompatibleChatCompletionInput,
) => {
  // Always use IPC in Electron to avoid CORS issues in production (webSecurity: true)
  if (ipcServices?.ai?.openAICompatibleChatCompletion) {
    return ipcServices.ai.openAICompatibleChatCompletion(
      input,
    ) as Promise<OpenAICompatibleChatCompletionResponse>
  }

  // In non-Electron environments (web), use direct fetch
  return fetchOpenAICompatibleChatCompletion(input)
}

const _fetchOpenAICompatibleEmbedding = async ({
  baseURL,
  apiKey,
  body,
}: OpenAICompatibleEmbeddingInput) => {
  const endpoint = `${normalizeOpenAIBaseURL(baseURL)}/embeddings`

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new Error(
      `Failed to reach embedding provider at ${baseURL}. Check the Base URL, network, proxy, or provider CORS settings. ${toReadableErrorMessage(error)}`,
    )
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "")
    throw new Error(errorText || `Embedding provider request failed with HTTP ${response.status}.`)
  }

  return response.json() as Promise<OpenAICompatibleEmbeddingResponse>
}

const fetchOpenAICompatibleEmbeddingViaProxy = async ({
  baseURL,
  apiKey,
  body,
}: OpenAICompatibleEmbeddingInput): Promise<OpenAICompatibleEmbeddingResponse> => {
  const response = await fetch("/api/embedding/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseURL: baseURL.replace(/\/+$/, ""), apiKey, payload: body }),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => "")
    throw new Error(errorText || `Embedding proxy request failed with HTTP ${response.status}.`)
  }

  return response.json() as Promise<OpenAICompatibleEmbeddingResponse>
}

export const requestOpenAICompatibleEmbedding = async (input: OpenAICompatibleEmbeddingInput) => {
  // Always use IPC in Electron to avoid CORS issues in production (webSecurity: true)
  if (ipcServices?.ai?.openAICompatibleEmbedding) {
    return ipcServices.ai.openAICompatibleEmbedding(
      input,
    ) as Promise<OpenAICompatibleEmbeddingResponse>
  }

  // In non-Electron environments (web), use the Vite proxy to bypass CORS
  return fetchOpenAICompatibleEmbeddingViaProxy(input)
}
