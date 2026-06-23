import type { EntryAiTagLabel } from "@follow/shared/entry-ai-tags"

/**
 * A topic is a content selector. Phase 1 supports AI tag buckets and keyword
 * queries; semantic / manual selectors are deferred to later phases.
 */
export type TopicSelector =
  | { type: "aiTag"; label: EntryAiTagLabel }
  | { type: "keyword"; query: string }

export type MyTopic = {
  id: string
  name: string
  selector: TopicSelector
  pinned: boolean
  pinnedAt?: number
  createdAt: number
  /** Drives the active / dormant lifecycle. */
  lastOpenedAt: number
}

export type MyTopicStatus = "active" | "dormant"

export type SidebarTopic = MyTopic & { status: MyTopicStatus }
