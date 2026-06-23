export const ENTRY_AI_TAG_CANDIDATES = [
  "AI",
  "产品",
  "行业",
  "技巧",
  "论文",
  "编程",
  "Agent",
  "设计",
  "创业",
  "商业",
] as const

export type EntryAiTagLabel = (typeof ENTRY_AI_TAG_CANDIDATES)[number]

export const MAX_ENTRY_AI_TAGS = 3

export type EntryAiTagAssignment = {
  label: EntryAiTagLabel
  confidence: number
  reason: string
}

// Genre / intent axis (how the article is written), distinct from the topic
// axis above. Embeddings classify this poorly, so it is produced by the LLM tag
// call. Keep this list tight; "其他" is the low-confidence fallback.
export const ENTRY_CONTENT_TYPE_CANDIDATES = [
  "快讯",
  "合集",
  "教程",
  "实测",
  "分析",
  "观点",
  "论文",
  "其他",
] as const

export type EntryContentType = (typeof ENTRY_CONTENT_TYPE_CANDIDATES)[number]

export const DEFAULT_ENTRY_CONTENT_TYPE: EntryContentType = "其他"

export type EntryContentTypeAssignment = {
  label: EntryContentType
  confidence: number
}
