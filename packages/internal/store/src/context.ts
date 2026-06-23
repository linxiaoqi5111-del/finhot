import type { AuthClient } from "@follow/shared/auth"
import type { EntryEmbeddingRecord } from "@follow/shared/entry-embedding"
import type { SupportedActionLanguage } from "@follow/shared/language"
import type { QueryClient } from "@tanstack/react-query"

import type { FollowAPI } from "./types"

const NO_VALUE_DEFAULT = Symbol("NO_VALUE_DEFAULT")
type ContextValue<T> = T | typeof NO_VALUE_DEFAULT

function createJSContext<T>() {
  let contextValue: ContextValue<T> = NO_VALUE_DEFAULT

  const provide = (value: T) => {
    contextValue = value
  }

  const consumer = (): T => {
    if (contextValue === NO_VALUE_DEFAULT) {
      throw new TypeError("You should only use this context value inside a provider.")
    }
    return contextValue
  }

  return {
    provide,
    consumer,
  }
}

function createOptionalJSContext<T>() {
  let contextValue: T | undefined

  const provide = (value?: T) => {
    contextValue = value
  }

  const consumer = (): T | undefined => contextValue

  return {
    provide,
    consumer,
  }
}

export interface SummaryGeneratorEntry {
  title?: string | null
  description?: string | null
  content?: string | null
  readabilityContent?: string | null
  url?: string | null
}

export interface SummaryGeneratorInput {
  entryId: string
  entry: SummaryGeneratorEntry
  target: "content" | "readabilityContent"
  actionLanguage: SupportedActionLanguage
}

export type SummaryGenerator = (input: SummaryGeneratorInput) => Promise<string | null>

export type TranslationGeneratorField = "title" | "description" | "content" | "readabilityContent"

export interface TranslationGeneratorEntry {
  title?: string | null
  description?: string | null
  content?: string | null
  readabilityContent?: string | null
  url?: string | null
}

export interface TranslationGeneratorInput {
  entryId: string
  entry: TranslationGeneratorEntry
  fields: readonly TranslationGeneratorField[]
  actionLanguage: SupportedActionLanguage
  mode: "bilingual" | "translation-only"
}

export type TranslationGeneratorResult = Partial<Record<TranslationGeneratorField, string | null>>

export type TranslationGenerator = (
  input: TranslationGeneratorInput,
) => Promise<TranslationGeneratorResult>

export interface TagGeneratorEntry {
  title?: string | null
  description?: string | null
  content?: string | null
  url?: string | null
}

export interface TagGeneratorInput {
  entryId: string
  entry: TagGeneratorEntry
  actionLanguage: SupportedActionLanguage
  summary?: string | null
}

export type TagGeneratorResult = {
  tags: Array<{
    label: string
    confidence: number
    reason: string
  }>
  // Genre/intent label, piggybacked on the same call. Validated downstream.
  contentType?: {
    label: string
    confidence: number
  } | null
}

export type TagGenerator = (input: TagGeneratorInput) => Promise<TagGeneratorResult>

export interface QualityScoreGeneratorEntry {
  title?: string | null
  description?: string | null
  content?: string | null
  readabilityContent?: string | null
  url?: string | null
  author?: string | null
  publishedAt?: Date | null
}

export interface QualityScoreGeneratorInput {
  entryId: string
  entry: QualityScoreGeneratorEntry
  actionLanguage: SupportedActionLanguage
  summary?: string | null
  source?: string | null
  guid?: string | null
  isYouTubeFeed?: boolean
  target?: "content" | "readabilityContent"
}

export type QualityScoreGeneratorResult = Record<string, unknown>

export type QualityScoreGenerator = (
  input: QualityScoreGeneratorInput,
) => Promise<QualityScoreGeneratorResult>

export interface EmbeddingGeneratorInput {
  entryId: string
  text: string
}

export type EmbeddingGenerator = (
  input: EmbeddingGeneratorInput,
) => Promise<EntryEmbeddingRecord | null>

export interface ReadabilityContentFetcherInput {
  entryId: string
  url: string
}

export type ReadabilityContentFetcher = (
  input: ReadabilityContentFetcherInput,
) => Promise<string | null | undefined>

export const apiContext = createJSContext<FollowAPI>()
export const authClientContext = createJSContext<AuthClient>()
export const queryClientContext = createJSContext<QueryClient>()
export const summaryGeneratorContext = createOptionalJSContext<SummaryGenerator>()
export const translationGeneratorContext = createOptionalJSContext<TranslationGenerator>()
export const tagGeneratorContext = createOptionalJSContext<TagGenerator>()
export const qualityScoreGeneratorContext = createOptionalJSContext<QualityScoreGenerator>()
export const embeddingGeneratorContext = createOptionalJSContext<EmbeddingGenerator>()
export const readabilityContentFetcherContext = createOptionalJSContext<ReadabilityContentFetcher>()

export const api = apiContext.consumer
export const authClient = authClientContext.consumer
export const queryClient = queryClientContext.consumer
export const summaryGenerator = summaryGeneratorContext.consumer
export const translationGenerator = translationGeneratorContext.consumer
export const tagGenerator = tagGeneratorContext.consumer
export const qualityScoreGenerator = qualityScoreGeneratorContext.consumer
export const embeddingGenerator = embeddingGeneratorContext.consumer
export const readabilityContentFetcher = readabilityContentFetcherContext.consumer
