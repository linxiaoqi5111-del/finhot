import { getEmbeddingProviderPreset } from "@follow/shared/embedding-provider"
import type {
  EmbeddingProviderPreset,
  UserEmbeddingProviderConfig,
} from "@follow/shared/settings/interface"

export function getEmbeddingDefaultConfig(
  preset: EmbeddingProviderPreset,
): UserEmbeddingProviderConfig {
  const option = getEmbeddingProviderPreset(preset)
  return {
    preset,
    baseURL: option?.defaultBaseURL ?? "",
    model: option?.defaultModel ?? "",
    dimension: option?.dimension ?? 1024,
    apiKey: null,
  }
}

export function resolveConfiguredEmbeddingProvider(
  provider: UserEmbeddingProviderConfig | null | undefined,
) {
  if (!provider) return null

  const preset = getEmbeddingProviderPreset(provider.preset)
  return {
    ...provider,
    baseURL: provider.baseURL || preset?.defaultBaseURL || "",
    model: provider.model || preset?.defaultModel || "",
    dimension: provider.dimension || preset?.dimension || 1024,
  }
}

export {
  EMBEDDING_PROVIDER_PRESETS,
  getEmbeddingProviderPreset,
} from "@follow/shared/embedding-provider"
