import { useAtomValue } from "jotai"
import { useMemo } from "react"

import { myTopicsAtom } from "./store"
import type { MyTopic } from "./types"

export const useMyTopics = () => useAtomValue(myTopicsAtom)

export const useMyTopicById = (id?: string): MyTopic | undefined => {
  const topics = useMyTopics()
  return useMemo(() => (id ? topics.find((topic) => topic.id === id) : undefined), [id, topics])
}
