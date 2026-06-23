import type { EntryModel } from "../entry/types"

export const EMBEDDING_TEXT_MAX_CHARS = 8_000

const plainTextForEmbedding = (value: string | null | undefined): string | null => {
  if (!value) return null

  const text = value
    .replaceAll(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replaceAll(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()

  return text || null
}

const entryContentText = (entry: EntryModel): string | null => {
  const raw = entry.readabilityContent?.trim() || entry.content?.trim()
  return plainTextForEmbedding(raw)
}

export const buildEmbeddingSourceText = (entry: EntryModel): string => {
  const title = plainTextForEmbedding(entry.title)
  const summary = plainTextForEmbedding(entry.description)
  const content = entryContentText(entry)

  return [title, summary, content].filter(Boolean).join("\n\n").slice(0, EMBEDDING_TEXT_MAX_CHARS)
}

export const hasEmbeddingEligibleText = (entry: EntryModel): boolean => {
  return buildEmbeddingSourceText(entry).length > 0
}

export const hashEmbeddingSourceText = (sourceText: string): string => {
  let hash = 5381

  for (const char of sourceText) {
    hash = (hash * 33) ^ (char.codePointAt(0) ?? 0)
  }

  return (hash >>> 0).toString(16)
}

export const embeddingSourceHashForEntry = (entry: EntryModel): string =>
  hashEmbeddingSourceText(buildEmbeddingSourceText(entry))

export const isEmbeddingStaleForEntry = (
  entry: EntryModel,
  embedding: { sourceHash?: string },
): boolean => {
  if (!embedding.sourceHash) return true

  return embedding.sourceHash !== embeddingSourceHashForEntry(entry)
}
