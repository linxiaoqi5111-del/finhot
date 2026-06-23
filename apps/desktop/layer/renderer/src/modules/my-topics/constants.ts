import { getStorageNS } from "@follow/utils/ns"

import type { MyTopic } from "./types"

export const MY_TOPICS_STORAGE_KEY = getStorageNS("my-topics")

const seedTime = Date.now()

export const DEFAULT_MY_TOPICS: MyTopic[] = [
  {
    id: "seed-ai",
    name: "AI",
    selector: { type: "aiTag", label: "AI" },
    pinned: false,
    createdAt: seedTime,
    lastOpenedAt: seedTime,
  },
  {
    id: "seed-product",
    name: "产品",
    selector: { type: "aiTag", label: "产品" },
    pinned: false,
    createdAt: seedTime,
    lastOpenedAt: seedTime,
  },
]
