import type { EmbeddingProviderPreset } from "./embedding-provider"

export interface EntryEmbeddingRecord {
  preset: EmbeddingProviderPreset | "custom"
  provider: string
  model: string
  dimension: number
  vector: number[]
  embedded_at: string
  /** Hash of title + RSS description + content used for embedding input. */
  sourceHash?: string
}
