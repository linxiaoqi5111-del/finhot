import { isOnboardingFeedUrl } from "@follow/store/constants/onboarding"
import { useFeedStore } from "@follow/store/feed/store"
import { useCategoriesByView } from "@follow/store/subscription/hooks"
import { useSortedCategoriesByUnread } from "@follow/store/unread/hooks"
import { sortByAlphabet } from "@follow/utils/utils"
import { Fragment, memo, useCallback, useMemo } from "react"

import { useEmptyFeedCategories } from "~/modules/subscription-column/atom"

import { useFeedListSortSelector } from "../atom"
import { FeedCategoryAutoHideUnread } from "../FeedCategory"
import type { FeedListProps } from "./types"

export const SortByUnreadFeedList = memo(({ view, data, categoryOpenStateData }: FeedListProps) => {
  const isDesc = useFeedListSortSelector((s) => s.order === "desc")
  const sortedByUnread = useSortedCategoriesByUnread(data, isDesc)
  const storedCategories = useCategoriesByView(view)
  const emptyFeedCategories = useEmptyFeedCategories(view)

  const emptyCategories = useMemo(() => {
    const categoryNames = new Set([...storedCategories, ...emptyFeedCategories])
    return Array.from(categoryNames).filter((category) => !data[category]?.length)
  }, [data, emptyFeedCategories, storedCategories])

  const sortedEmptyCategories = useMemo(() => {
    const sorted = emptyCategories.sort((a, b) => sortByAlphabet(a, b))
    return isDesc ? sorted : sorted.reverse()
  }, [emptyCategories, isDesc])

  // Separate categories with onboarding feeds and regular categories
  const sortedList = useFeedStore(
    useCallback(
      (state) => {
        if (!sortedByUnread) return []
        const onboardingCategories: [string, string[]][] = []
        const regularCategories: [string, string[]][] = []

        for (const [category, ids] of sortedByUnread) {
          const hasOnboardingFeed = ids.some((id) => {
            const feed = state.feeds[id]
            return feed && isOnboardingFeedUrl(feed.url)
          })

          if (hasOnboardingFeed) {
            onboardingCategories.push([category, ids.concat()])
          } else {
            regularCategories.push([category, ids.concat()])
          }
        }

        return [...onboardingCategories, ...regularCategories]
      },
      [sortedByUnread],
    ),
  )

  return (
    <Fragment>
      {sortedEmptyCategories.map((category) => (
        <FeedCategoryAutoHideUnread
          key={`empty-${category}`}
          data={[]}
          categoryName={category}
          view={view}
          categoryOpenStateData={categoryOpenStateData}
        />
      ))}
      {sortedList.map(([category, ids]) => (
        <FeedCategoryAutoHideUnread
          key={category}
          data={ids}
          view={view}
          categoryOpenStateData={categoryOpenStateData}
        />
      ))}
    </Fragment>
  )
})
