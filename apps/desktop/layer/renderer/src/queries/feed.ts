import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { feedSyncServices } from "@follow/store/feed/store"
import { tracker } from "@follow/tracker"
import { formatXml } from "@follow/utils/utils"
import { useMutation } from "@tanstack/react-query"
import { useRef } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { ROUTE_FEED_IN_FOLDER, ROUTE_FEED_PENDING } from "~/constants"
import { useAuthQuery } from "~/hooks/common"
import { followClient } from "~/lib/api-client"
import { defineQuery } from "~/lib/defineQuery"
import { toastFetchError } from "~/lib/error-parser"
import { previewLocalRssFeed } from "~/modules/local-rss/service"

type FeedQueryParams = { id?: string; url?: string }
const createLocalModeFeedCloudError = () =>
  new Error("Feed cloud actions are disabled in local RSS mode")

export const feed = {
  byId: ({ id, url }: FeedQueryParams) =>
    defineQuery(
      ["feed", id, url],
      async () =>
        LOCAL_RSS_MODE
          ? previewLocalRssFeed({
              id,
              url,
            })
          : feedSyncServices.fetchFeedById({
              id,
              url,
            }),
      {
        rootKey: ["feed"],
      },
    ),
  claimMessage: ({ feedId }: { feedId: string }) =>
    defineQuery(["feed", "claimMessage", feedId], async () => {
      if (LOCAL_RSS_MODE) {
        throw createLocalModeFeedCloudError()
      }

      return followClient.api.feeds.claim.message({ feedId }).then((res) => {
        res.data.json = JSON.stringify(JSON.parse(res.data.json), null, 2)
        const $document = new DOMParser().parseFromString(res.data.xml, "text/xml")
        res.data.xml = formatXml(new XMLSerializer().serializeToString($document))
        return res
      })
    }),
  claimedList: () =>
    defineQuery(["feed", "claimedList"], async () => {
      if (LOCAL_RSS_MODE) {
        return []
      }

      const res = await followClient.api.feeds.claim.list()
      return res.data
    }),
}

export const useFeedQuery = ({ id, url }: FeedQueryParams) =>
  useAuthQuery(
    feed.byId({
      id,
      url,
    }),
    {
      enabled:
        (!!id || !!url) && id !== ROUTE_FEED_PENDING && !id?.startsWith(ROUTE_FEED_IN_FOLDER),
      staleTime: LOCAL_RSS_MODE ? 5 * 60 * 1000 : undefined,
    },
  )

export const useClaimFeedMutation = (feedId: string) =>
  useMutation({
    mutationKey: ["claimFeed", feedId],
    mutationFn: () => {
      if (LOCAL_RSS_MODE) {
        throw createLocalModeFeedCloudError()
      }

      return feedSyncServices.claimFeed(feedId)
    },

    async onError(err) {
      toastFetchError(err)
    },
    onSuccess() {
      tracker.feedClaimed({
        feedId,
      })
    },
  })

export const useRefreshFeedMutation = (feedId?: string) =>
  useMutation({
    mutationKey: ["refreshFeed", feedId],
    mutationFn: () => {
      if (LOCAL_RSS_MODE) {
        throw createLocalModeFeedCloudError()
      }

      return followClient.api.feeds.refresh({ id: feedId! })
    },
    async onError(err) {
      toastFetchError(err)
    },
  })

export const useResetFeed = () => {
  const { t } = useTranslation()
  const toastIDRef = useRef<string | number | null>(null)

  return useMutation({
    mutationFn: async (feedId: string) => {
      if (LOCAL_RSS_MODE) {
        throw createLocalModeFeedCloudError()
      }

      toastIDRef.current = toast.loading(t("sidebar.feed_actions.resetting_feed"))
      await followClient.api.feeds.reset({ id: feedId })
    },
    onSuccess: () => {
      toast.success(
        t("sidebar.feed_actions.reset_feed_success"),
        toastIDRef.current ? { id: toastIDRef.current } : undefined,
      )
    },
    onError: () => {
      toast.error(
        t("sidebar.feed_actions.reset_feed_error"),
        toastIDRef.current ? { id: toastIDRef.current } : undefined,
      )
    },
  })
}
