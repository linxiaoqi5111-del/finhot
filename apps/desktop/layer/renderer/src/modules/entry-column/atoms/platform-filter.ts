import { getSubscriptionByFeedId } from "@follow/store/subscription/getter"
import { atom, useAtomValue, useSetAtom } from "jotai"

export type PlatformFilter = "all" | "xueqiu" | "weibo" | "twitter" | "wechat" | "other"

export const platformFilterAtom = atom<PlatformFilter>("all")

export const usePlatformFilter = () => useAtomValue(platformFilterAtom)
export const useSetPlatformFilter = () => useSetAtom(platformFilterAtom)

export const PLATFORM_LABELS: Record<PlatformFilter, string> = {
  all: "全部",
  xueqiu: "雪球",
  weibo: "微博",
  twitter: "推特",
  wechat: "公众号",
  other: "其他",
}

/**
 * Determine which platform a feed belongs to.
 * Checks feed URL patterns first, then falls back to subscription category.
 */
export function getPlatformForFeed(
  feedId: string | undefined | null,
  feedUrl: string | undefined | null,
): PlatformFilter {
  if (!feedUrl && !feedId) return "other"

  // URL-based detection
  if (feedUrl) {
    if (/xueqiu/i.test(feedUrl)) return "xueqiu"
    if (/twitter|\/x\.com\//i.test(feedUrl)) return "twitter"
    if (/weibo/i.test(feedUrl)) return "weibo"
    if (/wechat|mp\.weixin/i.test(feedUrl)) return "wechat"
  }

  // Category-based detection (covers wechat2rss feeds whose URL is opaque)
  if (feedId) {
    const sub = getSubscriptionByFeedId(feedId)
    if (sub?.category === "公众号") return "wechat"
  }

  return "other"
}
