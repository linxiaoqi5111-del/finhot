import type { MyTopic, MyTopicStatus, TopicSelector } from "./types"

export type MatchableEntry = { title?: string | null }
export type MatchableTag = { label: string }

/**
 * Pure predicate: does an entry belong to a topic selector?
 * - aiTag: the entry carries the matching AI tag
 * - keyword: case-insensitive substring match on the title (Phase 1 keeps this
 *   cheap; content/semantic matching is deferred)
 */
export const matchEntryBySelector = (
  selector: TopicSelector,
  entry: MatchableEntry,
  tags?: MatchableTag[],
): boolean => {
  switch (selector.type) {
    case "aiTag": {
      return tags?.some((tag) => tag.label === selector.label) ?? false
    }
    case "keyword": {
      const query = selector.query.trim().toLowerCase()
      if (!query) return false
      return (entry.title ?? "").toLowerCase().includes(query)
    }
    default: {
      return false
    }
  }
}

export const getTopicStatus = (
  topic: MyTopic,
  now: number,
  activeWindowMs: number,
): MyTopicStatus =>
  topic.pinned || now - topic.lastOpenedAt <= activeWindowMs ? "active" : "dormant"

/** Two selectors are considered the same followed topic. */
export const isSameSelector = (a: TopicSelector, b: TopicSelector): boolean => {
  if (a.type !== b.type) return false
  if (a.type === "aiTag" && b.type === "aiTag") return a.label === b.label
  if (a.type === "keyword" && b.type === "keyword") {
    return a.query.trim().toLowerCase() === b.query.trim().toLowerCase()
  }
  return false
}
