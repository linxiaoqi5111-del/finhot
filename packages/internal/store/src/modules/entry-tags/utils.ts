import type {
  EntryAiTagAssignment,
  EntryAiTagLabel,
  EntryContentType,
  EntryContentTypeAssignment,
} from "@follow/shared/entry-ai-tags"
import {
  ENTRY_AI_TAG_CANDIDATES,
  ENTRY_CONTENT_TYPE_CANDIDATES,
  MAX_ENTRY_AI_TAGS,
} from "@follow/shared/entry-ai-tags"

const candidateSet = new Set<string>(ENTRY_AI_TAG_CANDIDATES)

const isEntryAiTagLabel = (label: string): label is EntryAiTagLabel => candidateSet.has(label)

const contentTypeSet = new Set<string>(ENTRY_CONTENT_TYPE_CANDIDATES)

const isEntryContentType = (label: string): label is EntryContentType => contentTypeSet.has(label)

const clampConfidence = (value: number) => Math.min(1, Math.max(0, value))

export const validateContentType = (raw: unknown): EntryContentTypeAssignment | null => {
  if (!raw || typeof raw !== "object") return null

  const record = raw as Record<string, unknown>
  const label = typeof record.label === "string" ? record.label.trim() : ""
  if (!isEntryContentType(label)) return null

  const confidenceValue =
    typeof record.confidence === "number" ? record.confidence : Number(record.confidence)
  if (!Number.isFinite(confidenceValue)) return null

  return {
    label,
    confidence: clampConfidence(confidenceValue),
  }
}

export const validateTagAssignments = (raw: unknown): EntryAiTagAssignment[] => {
  if (!raw || typeof raw !== "object") return []

  const tagsValue = "tags" in raw ? (raw as { tags: unknown }).tags : null
  if (!Array.isArray(tagsValue)) return []

  const seen = new Set<string>()
  const validated: EntryAiTagAssignment[] = []

  for (const item of tagsValue) {
    if (!item || typeof item !== "object") continue

    const record = item as Record<string, unknown>
    const label = typeof record.label === "string" ? record.label.trim() : ""
    if (!isEntryAiTagLabel(label) || seen.has(label)) continue

    const confidenceValue =
      typeof record.confidence === "number" ? record.confidence : Number(record.confidence)
    if (!Number.isFinite(confidenceValue)) continue

    const reason = typeof record.reason === "string" ? record.reason.trim() : ""
    seen.add(label)
    validated.push({
      label,
      confidence: Math.min(1, Math.max(0, confidenceValue)),
      reason: reason || "Matched based on article content.",
    })
  }

  return validated.sort((a, b) => b.confidence - a.confidence).slice(0, MAX_ENTRY_AI_TAGS)
}
