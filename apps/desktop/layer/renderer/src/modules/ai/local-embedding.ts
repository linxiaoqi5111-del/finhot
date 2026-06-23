import { getEmbeddingProviderPreset } from "@follow/shared/embedding-provider"
import type { EntryEmbeddingRecord } from "@follow/shared/entry-embedding"
import type { EmbeddingGenerator } from "@follow/store/context"

import { getAISettings } from "~/atoms/settings/ai"

import { requestOpenAICompatibleEmbedding } from "./local-byok-request"

const normalizeOpenAIBaseURL = (baseURL: string) => baseURL.replace(/\/+$/, "")

export const generateLocalEmbedding: EmbeddingGenerator = async ({ text }) => {
  const embeddingSettings = getAISettings().embedding
  if (!embeddingSettings?.enabled || !embeddingSettings.provider) {
    return null
  }

  const { provider } = embeddingSettings
  const apiKey = provider.apiKey?.trim()
  if (!apiKey) return null

  const preset = getEmbeddingProviderPreset(provider.preset)
  const baseURL = normalizeOpenAIBaseURL(provider.baseURL || preset?.defaultBaseURL || "")
  const model = provider.model || preset?.defaultModel
  if (!baseURL || !model) return null

  const payload = await requestOpenAICompatibleEmbedding({
    baseURL,
    apiKey,
    body: {
      model,
      input: text,
    },
  })
  const vector = payload.data?.[0]?.embedding
  if (!vector || vector.length === 0) return null

  const dimension = provider.dimension ?? preset?.dimension ?? vector.length
  if (vector.length !== dimension) {
    console.warn(`[embedding] Dimension mismatch: expected ${dimension}, received ${vector.length}`)
    return null
  }

  const record: EntryEmbeddingRecord = {
    preset: provider.preset,
    provider: provider.preset,
    model,
    dimension,
    vector,
    embedded_at: new Date().toISOString(),
  }

  return record
}
