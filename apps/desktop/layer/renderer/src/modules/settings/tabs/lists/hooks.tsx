import type { FeedViewType } from "@follow/constants"
import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { subscriptionSyncService } from "@follow/store/subscription/store"
import { useCallback } from "react"
import { useTranslation } from "react-i18next"

import { useModalStack } from "~/components/ui/modal/stacked/hooks"
import { useBatchUpdateSubscription } from "~/hooks/biz/useSubscriptionActions"
import { addEmptyFeedCategory, removeEmptyFeedCategory } from "~/modules/subscription-column/atom"

import { CategoryCreationModalContent } from "./modals"

export const useCategoryCreationModal = () => {
  const { t } = useTranslation()
  const { present } = useModalStack()
  const { mutate: addFeedsToCategoryMutation } = useBatchUpdateSubscription()
  return useCallback(
    (view: FeedViewType, feedIds: string[] = []) =>
      present({
        title:
          feedIds.length > 0
            ? t("sidebar.feed_column.context_menu.title")
            : t("sidebar.feed_column.create_group_modal.title"),
        content: () => (
          <CategoryCreationModalContent
            onSubmit={(category: string) => {
              if (feedIds.length > 0) {
                addFeedsToCategoryMutation({
                  feedIdList: feedIds,
                  category,
                  view,
                })
                removeEmptyFeedCategory(view, category)
                return
              }

              void subscriptionSyncService.createCategory({ category, view })
              if (LOCAL_RSS_MODE) {
                addEmptyFeedCategory(view, category)
              }
            }}
          />
        ),
      }),
    [addFeedsToCategoryMutation, present, t],
  )
}
