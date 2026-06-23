import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { getFeedById } from "@follow/store/feed/getter"
import type { FeedModel } from "@follow/store/feed/types"

import { UrlBuilder } from "./url-builder"

export const getFeedExternalUrl = (feed: Pick<FeedModel, "siteUrl" | "url"> | null | undefined) => {
  if (!feed) return null
  return feed.siteUrl || feed.url || null
}

export const openFeedInBrowser = (feedId: string, view?: number) => {
  if (LOCAL_RSS_MODE) {
    const externalUrl = getFeedExternalUrl(getFeedById(feedId))
    if (externalUrl) {
      window.open(externalUrl, "_blank", "noopener,noreferrer")
      return
    }
  }

  window.open(UrlBuilder.shareFeed(feedId, view), "_blank", "noopener,noreferrer")
}
