import type { EntryAiTagLabel } from "@follow/shared/entry-ai-tags"
import { ENTRY_AI_TAG_CANDIDATES } from "@follow/shared/entry-ai-tags"

import { FEED_COLLECTION_LIST } from "~/constants"

export const SMART_FEED_TODAY = "smart-today"
export const SMART_FEED_YESTERDAY = "smart-yesterday"
export const SMART_FEED_UNREAD = "smart-unread"
export const SMART_FEED_RADAR = "smart-radar"

export const TOPIC_FEED_PREFIX = "topic-"
export const MYTOPIC_FEED_PREFIX = "mytopic-"

export type SmartFeedScope = "today" | "yesterday" | "unread" | "starred"

const SMART_FEED_BY_ID: Record<string, SmartFeedScope> = {
  [SMART_FEED_TODAY]: "today",
  [SMART_FEED_YESTERDAY]: "yesterday",
  [SMART_FEED_UNREAD]: "unread",
  [FEED_COLLECTION_LIST]: "starred",
}

const isEntryAiTagLabel = (label: string): label is EntryAiTagLabel =>
  (ENTRY_AI_TAG_CANDIDATES as readonly string[]).includes(label)

export const getSmartFeedScope = (feedId: string | undefined): SmartFeedScope | undefined => {
  if (!feedId) return
  return SMART_FEED_BY_ID[feedId]
}

export const getTopicFeedId = (label: EntryAiTagLabel) =>
  `${TOPIC_FEED_PREFIX}${encodeURIComponent(label)}`

export const getTopicLabelFromFeedId = (
  feedId: string | undefined,
): EntryAiTagLabel | undefined => {
  if (!feedId?.startsWith(TOPIC_FEED_PREFIX)) return

  try {
    const label = decodeURIComponent(feedId.slice(TOPIC_FEED_PREFIX.length))
    return isEntryAiTagLabel(label) ? label : undefined
  } catch {
    return
  }
}

export const getMyTopicFeedId = (id: string) => `${MYTOPIC_FEED_PREFIX}${id}`

export const getMyTopicIdFromFeedId = (feedId: string | undefined): string | undefined => {
  if (!feedId?.startsWith(MYTOPIC_FEED_PREFIX)) return
  const id = feedId.slice(MYTOPIC_FEED_PREFIX.length)
  return id || undefined
}

export const isVirtualTimelineScopeFeedId = (feedId: string | undefined) =>
  feedId === SMART_FEED_RADAR ||
  !!getSmartFeedScope(feedId) ||
  !!getTopicLabelFromFeedId(feedId) ||
  !!getMyTopicIdFromFeedId(feedId)
