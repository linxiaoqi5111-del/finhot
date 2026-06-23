import type { FeedViewType } from "@follow/constants"
import { getStorageNS } from "@follow/utils/ns"
import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"

import { createAtomHooks } from "~/lib/jotai"

type EmptyFeedCategoriesByView = Partial<Record<FeedViewType, string[]>>

const [
  ,
  ,
  useEmptyFeedCategoriesByView,
  ,
  getEmptyFeedCategoriesByView,
  setEmptyFeedCategoriesByView,
] = createAtomHooks(
  atomWithStorage<EmptyFeedCategoriesByView>(getStorageNS("empty-feed-categories"), {}, undefined, {
    getOnInit: true,
  }),
)

export { getEmptyFeedCategoriesByView }

export const useEmptyFeedCategories = (view: FeedViewType) => {
  const categoriesByView = useEmptyFeedCategoriesByView()
  return categoriesByView[view] ?? []
}

export const addEmptyFeedCategory = (view: FeedViewType, category: string) => {
  const current = getEmptyFeedCategoriesByView()
  const categories = new Set(current[view] ?? [])
  categories.add(category)
  setEmptyFeedCategoriesByView({
    ...current,
    [view]: Array.from(categories),
  })
}

export const removeEmptyFeedCategory = (view: FeedViewType, category: string) => {
  const current = getEmptyFeedCategoriesByView()
  const nextCategories = (current[view] ?? []).filter((name) => name !== category)
  setEmptyFeedCategoriesByView({
    ...current,
    [view]: nextCategories.length > 0 ? nextCategories : undefined,
  })
}

export const renameEmptyFeedCategory = (
  view: FeedViewType,
  lastCategory: string,
  newCategory: string,
) => {
  const current = getEmptyFeedCategoriesByView()
  const categories = current[view] ?? []
  if (!categories.includes(lastCategory)) return

  const nextCategories = categories.map((name) => (name === lastCategory ? newCategory : name))
  setEmptyFeedCategoriesByView({
    ...current,
    [view]: nextCategories,
  })
}

export type FeedListSortBy = "count" | "alphabetical"
export type FeedListSortOrder = "asc" | "desc"
const [, , useFeedListSort, , getFeedListSort, setFeedListSort, useFeedListSortSelector] =
  createAtomHooks(
    atomWithStorage(
      getStorageNS("feedListSort"),
      {
        by: "count" as FeedListSortBy,
        order: "desc" as FeedListSortOrder,
      },
      undefined,
      { getOnInit: true },
    ),
  )

export { getFeedListSort, useFeedListSort, useFeedListSortSelector }

export const setFeedListSortBy = (by: FeedListSortBy) => {
  setFeedListSort({
    ...getFeedListSort(),
    by,
  })
}

export const setFeedListSortOrder = (order: FeedListSortOrder) => {
  setFeedListSort({
    ...getFeedListSort(),
    order,
  })
}

const SELECT_NOTHING = []
export const [, useSelectedFeedIdsState, , , getSelectedFeedIds, setSelectedFeedIds, ,] =
  createAtomHooks(atom<string[]>(SELECT_NOTHING))
export const resetSelectedFeedIds = () => {
  setSelectedFeedIds(SELECT_NOTHING)
}

export const [, , useFeedAreaScrollProgressValue, , , setFeedAreaScrollProgressValue] =
  createAtomHooks(atom(0))
