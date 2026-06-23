import type { EntryAiTagLabel } from "@follow/shared/entry-ai-tags"
import { atomWithStorage } from "jotai/utils"

import { jotaiStore } from "~/lib/jotai"

import { DEFAULT_MY_TOPICS, MY_TOPICS_STORAGE_KEY } from "./constants"
import { isSameSelector } from "./selector"
import type { MyTopic, TopicSelector } from "./types"

export const myTopicsAtom = atomWithStorage<MyTopic[]>(MY_TOPICS_STORAGE_KEY, DEFAULT_MY_TOPICS)

// Must use the app's jotai store (see root-providers.tsx <Provider store={jotaiStore}>),
// otherwise imperative writes land in a different store than what components read.
const store = jotaiStore

const update = (updater: (prev: MyTopic[]) => MyTopic[]) => {
  store.set(myTopicsAtom, updater(store.get(myTopicsAtom)))
}

const genId = () => `topic_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

const findBySelector = (topics: MyTopic[], selector: TopicSelector) =>
  topics.find((topic) => isSameSelector(topic.selector, selector))

/** Follow a topic; returns the id of the new or pre-existing topic. */
const follow = (name: string, selector: TopicSelector): string => {
  const existing = findBySelector(store.get(myTopicsAtom), selector)
  if (existing) {
    update((prev) =>
      prev.map((topic) =>
        topic.id === existing.id ? { ...topic, lastOpenedAt: Date.now() } : topic,
      ),
    )
    return existing.id
  }

  const now = Date.now()
  const topic: MyTopic = {
    id: genId(),
    name: name.trim() || name,
    selector,
    pinned: false,
    createdAt: now,
    lastOpenedAt: now,
  }
  update((prev) => [...prev, topic])
  return topic.id
}

export const myTopicActions = {
  followAiTag(label: EntryAiTagLabel): string {
    return follow(label, { type: "aiTag", label })
  },

  followKeyword(query: string, name?: string): string {
    const trimmed = query.trim()
    return follow(name ?? trimmed, { type: "keyword", query: trimmed })
  },

  unfollow(id: string) {
    update((prev) => prev.filter((topic) => topic.id !== id))
  },

  togglePin(id: string) {
    const now = Date.now()
    update((prev) =>
      prev.map((topic) =>
        topic.id === id
          ? { ...topic, pinned: !topic.pinned, pinnedAt: topic.pinned ? undefined : now }
          : topic,
      ),
    )
  },

  rename(id: string, name: string) {
    update((prev) => prev.map((topic) => (topic.id === id ? { ...topic, name } : topic)))
  },

  touchOpened(id: string) {
    update((prev) =>
      prev.map((topic) => (topic.id === id ? { ...topic, lastOpenedAt: Date.now() } : topic)),
    )
  },
}

export const getMyTopics = () => store.get(myTopicsAtom)

export const getMyTopicById = (id?: string) =>
  id ? store.get(myTopicsAtom).find((topic) => topic.id === id) : undefined
