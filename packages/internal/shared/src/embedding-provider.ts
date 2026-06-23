export type EmbeddingProviderPreset = "siliconflow" | "gemini" | "custom"

export interface EmbeddingProviderPresetOption {
  value: EmbeddingProviderPreset
  label: string
  defaultBaseURL: string
  defaultModel: string
  dimension: number
  iconClassName: string
}

export const EMBEDDING_PROVIDER_PRESETS: EmbeddingProviderPresetOption[] = [
  {
    value: "siliconflow",
    label: "SiliconFlow",
    defaultBaseURL: "https://api.siliconflow.com/v1",
    defaultModel: "Qwen/Qwen3-Embedding-0.6B",
    dimension: 1024,
    iconClassName: "i-focal-ai",
  },
  {
    value: "gemini",
    label: "Google Gemini",
    defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-embedding-001",
    dimension: 768,
    iconClassName: "i-focal-google",
  },
  {
    value: "custom",
    label: "Custom",
    defaultBaseURL: "",
    defaultModel: "",
    dimension: 1024,
    iconClassName: "i-focal-settings-3",
  },
]

export function getEmbeddingProviderPreset(preset: EmbeddingProviderPreset) {
  return EMBEDDING_PROVIDER_PRESETS.find((option) => option.value === preset)
}
