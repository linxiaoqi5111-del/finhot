/**
 * AddBloggerPanel — select platform + enter username to auto-generate RSSHub URL and subscribe.
 *
 * Supports:
 * - Platform-specific RSSHub routes (weibo, xueqiu, twitter, etc.)
 * - wechat2rss private deployment for WeChat public accounts
 * - Feed auto-discovery (any URL)
 */

import { Button } from "@follow/components/ui/button/index.js"
import { FeedViewType, LOCAL_RSSHUB_BASE } from "@follow/constants"
import { cn } from "@follow/utils/utils"
import { useCallback, useState } from "react"

import { useIntegrationSettingKey } from "~/atoms/settings/integration"
import type { DiscoveredFeed } from "~/modules/feed-discovery/service"
import { discoverFeeds } from "~/modules/feed-discovery/service"
import { previewLocalRssFeed, upsertLocalRssSubscription } from "~/modules/local-rss/service"
import {
  addAccountById,
  addAccountByUrl,
  isWechat2rssConfigured,
} from "~/modules/wechat2rss/service"

interface Platform {
  id: string
  label: string
  icon: string
  placeholder: string
  hint: string
  buildUrl: (input: string) => string
  /** If true, uses wechat2rss service instead of RSSHub */
  useWechat2rss?: boolean
  /** If true, uses feed auto-discovery */
  useDiscovery?: boolean
}

const PLATFORMS: Platform[] = [
  {
    id: "weibo",
    label: "微博",
    icon: "🔴",
    placeholder: "输入博主 UID（如 1642634100）",
    hint: "打开博主主页，URL 中的数字即为 UID",
    buildUrl: (uid: string) => `${LOCAL_RSSHUB_BASE}/weibo/user/${uid.trim()}`,
  },
  {
    id: "xueqiu",
    label: "雪球",
    icon: "🟡",
    placeholder: "输入用户 UID（如 6784593966）",
    hint: "xueqiu.com/u/xxx 中的数字",
    buildUrl: (uid: string) => `${LOCAL_RSSHUB_BASE}/xueqiu/user/${uid.trim()}`,
  },
  {
    id: "twitter",
    label: "X / Twitter",
    icon: "⚫",
    placeholder: "输入用户名 或 X 链接",
    hint: "支持：用户名（elonmusk）、X 链接（https://x.com/elonmusk）",
    buildUrl: (input: string) => {
      const trimmed = input.trim()
      // Already a full RSS URL (XGo, etc.) — pass through
      if (/^https?:\/\/.+\/rss/i.test(trimmed)) return trimmed
      // Extract handle from x.com / twitter.com links
      const xUrlMatch = /(?:x\.com|twitter\.com)\/(\w+)\/?$/.exec(trimmed)
      const handle = xUrlMatch ? xUrlMatch[1] : trimmed.replace(/^@/, "")
      // Use internal scheme handled by the RSS proxy's Twitter converter
      return `finhot://twitter/${handle}`
    },
  },
  {
    id: "zhihu",
    label: "知乎",
    icon: "🔵",
    placeholder: "输入用户 ID（如 excited-vczh）",
    hint: "知乎个人主页 URL 中 /people/ 后面的 ID",
    buildUrl: (id: string) => `${LOCAL_RSSHUB_BASE}/zhihu/people/activities/${id.trim()}`,
  },
  {
    id: "bilibili",
    label: "B站",
    icon: "🩵",
    placeholder: "输入 UP主 UID（如 546195）",
    hint: "B站个人空间 URL 中的数字",
    buildUrl: (uid: string) => `${LOCAL_RSSHUB_BASE}/bilibili/user/video/${uid.trim()}`,
  },
  {
    id: "wechat",
    label: "公众号",
    icon: "🟢",
    placeholder: "输入公众号 ID 或文章链接",
    hint: "需要配置 wechat2rss 服务（设置 > 集成）",
    buildUrl: (id: string) => id.trim(),
    useWechat2rss: true,
  },
  {
    id: "discover",
    label: "自动发现",
    icon: "🔍",
    placeholder: "输入任意网站 URL（如 https://example.com）",
    hint: "自动检测网站的 RSS/Atom/JSON Feed 订阅源",
    buildUrl: (url: string) => url.trim(),
    useDiscovery: true,
  },
]

type SubscribeStatus = "idle" | "loading" | "success" | "error" | "discovering"

export function AddBloggerPanel({ onClose }: { onClose?: () => void }) {
  const [selectedPlatform, setSelectedPlatform] = useState<Platform>(PLATFORMS[0]!)
  const [input, setInput] = useState("")
  const [status, setStatus] = useState<SubscribeStatus>("idle")
  const [errorMsg, setErrorMsg] = useState("")
  const [successMsg, setSuccessMsg] = useState("")
  const [discoveredFeeds, setDiscoveredFeeds] = useState<DiscoveredFeed[]>([])

  const wechat2rssEnabled = useIntegrationSettingKey("enableWechat2rss")

  const handleWechat2rssSubscribe = useCallback(async (trimmed: string) => {
    if (!isWechat2rssConfigured()) {
      throw new Error("wechat2rss 未配置。请在设置 > 集成中填写服务地址和 Token。")
    }

    // Detect if input is a WeChat article URL or a biz ID
    const isArticleUrl =
      trimmed.startsWith("http://mp.weixin.qq.com") ||
      trimmed.startsWith("https://mp.weixin.qq.com")
    const feedUrl = isArticleUrl ? await addAccountByUrl(trimmed) : await addAccountById(trimmed)

    // Subscribe to the returned feed URL
    const preview = await previewLocalRssFeed({ url: feedUrl })
    const feedData = preview.feed

    await upsertLocalRssSubscription({
      feed: { ...feedData, type: "feed" as const },
      subscription: {
        url: feedUrl,
        view: FeedViewType.Articles,
        category: "公众号",
        isPrivate: false,
        hideFromTimeline: null,
        title: feedData.title || `公众号 - ${trimmed}`,
        feedId: feedData.id,
        listId: undefined,
      },
    })

    return feedData.title || trimmed
  }, [])

  const handleDiscovery = useCallback(async (trimmed: string) => {
    setStatus("discovering")
    setDiscoveredFeeds([])

    const feeds = await discoverFeeds(trimmed)
    if (feeds.length === 0) {
      throw new Error("未发现任何 RSS 订阅源。请确认 URL 是否正确。")
    }

    if (feeds.length === 1) {
      // Single feed found — subscribe directly
      return feeds[0]!
    }

    // Multiple feeds — show selection
    setDiscoveredFeeds(feeds)
    setStatus("idle")
    return null
  }, [])

  const subscribeToFeed = useCallback(async (feedUrl: string, category: string) => {
    const preview = await previewLocalRssFeed({ url: feedUrl })
    const feedData = preview.feed

    await upsertLocalRssSubscription({
      feed: { ...feedData, type: "feed" as const },
      subscription: {
        url: feedUrl,
        view: FeedViewType.Articles,
        category,
        isPrivate: false,
        hideFromTimeline: null,
        title: feedData.title || feedUrl,
        feedId: feedData.id,
        listId: undefined,
      },
    })

    return feedData.title || feedUrl
  }, [])

  const handleSubscribe = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed) return

    setStatus("loading")
    setErrorMsg("")
    setSuccessMsg("")
    setDiscoveredFeeds([])

    try {
      let title: string

      if (selectedPlatform.useWechat2rss) {
        title = await handleWechat2rssSubscribe(trimmed)
      } else if (selectedPlatform.useDiscovery) {
        const feed = await handleDiscovery(trimmed)
        if (!feed) return // Multiple feeds found, user needs to select
        title = await subscribeToFeed(feed.url, "自动发现")
      } else {
        const url = selectedPlatform.buildUrl(trimmed)
        const preview = await previewLocalRssFeed({ url })
        const feedData = preview.feed

        await upsertLocalRssSubscription({
          feed: { ...feedData, type: "feed" as const },
          subscription: {
            url,
            view: FeedViewType.Articles,
            category: "博主关注",
            isPrivate: false,
            hideFromTimeline: null,
            title: feedData.title || `${selectedPlatform.label} - ${trimmed}`,
            feedId: feedData.id,
            listId: undefined,
          },
        })
        title = feedData.title || trimmed
      }

      setStatus("success")
      setSuccessMsg(`已订阅：${title}`)
      setInput("")
    } catch (error) {
      setStatus("error")
      const msg = error instanceof Error ? error.message : "订阅失败"
      setErrorMsg(msg)
    }
  }, [input, selectedPlatform, handleWechat2rssSubscribe, handleDiscovery, subscribeToFeed])

  const handleDiscoveredFeedSelect = useCallback(
    async (feed: DiscoveredFeed) => {
      setStatus("loading")
      setErrorMsg("")
      try {
        const title = await subscribeToFeed(feed.url, "自动发现")
        setStatus("success")
        setSuccessMsg(`已订阅：${title}`)
        setInput("")
        setDiscoveredFeeds([])
      } catch (error) {
        setStatus("error")
        const msg = error instanceof Error ? error.message : "订阅失败"
        setErrorMsg(msg)
      }
    },
    [subscribeToFeed],
  )

  const isWechatUnconfigured = selectedPlatform.useWechat2rss && !wechat2rssEnabled

  return (
    <div className="flex w-full max-w-[560px] flex-col gap-5 rounded-xl border border-border bg-background p-6 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text">添加订阅</h2>
        {onClose && (
          <button type="button" onClick={onClose} className="text-text-tertiary hover:text-text">
            <svg className="size-5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Platform Selector */}
      <div>
        <label className="mb-2 block text-sm font-medium text-text-secondary">选择来源</label>
        <div className="grid grid-cols-4 gap-2">
          {PLATFORMS.map((platform) => (
            <button
              key={platform.id}
              type="button"
              onClick={() => {
                setSelectedPlatform(platform)
                setInput("")
                setStatus("idle")
                setErrorMsg("")
                setSuccessMsg("")
                setDiscoveredFeeds([])
              }}
              className={cn(
                "flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-sm transition-colors",
                selectedPlatform.id === platform.id
                  ? "border-red/40 bg-red/5 font-medium text-text"
                  : "border-border bg-fill-quaternary text-text-secondary hover:border-fill-tertiary",
              )}
            >
              <span>{platform.icon}</span>
              <span className="truncate">{platform.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* wechat2rss config warning */}
      {isWechatUnconfigured && (
        <div className="rounded-md bg-orange/10 px-3 py-2 text-sm text-orange">
          公众号订阅需要配置 wechat2rss 私有部署服务。请前往{" "}
          <span className="font-medium">设置 &gt; 集成</span> 中填写服务地址和 Token。
        </div>
      )}

      {/* Input */}
      <div>
        <label className="mb-2 block text-sm font-medium text-text-secondary">
          {selectedPlatform.useDiscovery ? "网站 URL" : `${selectedPlatform.label} 用户标识`}
        </label>
        <input
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setStatus("idle")
            setErrorMsg("")
            setSuccessMsg("")
            setDiscoveredFeeds([])
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim() && !isWechatUnconfigured) {
              handleSubscribe()
            }
          }}
          placeholder={selectedPlatform.placeholder}
          className="w-full rounded-lg border border-border bg-fill-quaternary px-4 py-2.5 text-sm text-text placeholder:text-text-quaternary focus:border-red/40 focus:outline-none focus:ring-1 focus:ring-red/20"
        />
        <p className="mt-1.5 text-xs text-text-tertiary">{selectedPlatform.hint}</p>
      </div>

      {/* Generated URL Preview (for non-wechat2rss, non-discovery platforms) */}
      {input.trim() && !selectedPlatform.useWechat2rss && !selectedPlatform.useDiscovery && (
        <div className="rounded-md bg-fill-secondary px-3 py-2">
          <span className="text-xs text-text-tertiary">RSS 地址：</span>
          <code className="mt-0.5 block break-all text-xs text-text-secondary">
            {selectedPlatform.buildUrl(input)}
          </code>
        </div>
      )}

      {/* Discovered Feeds List */}
      {discoveredFeeds.length > 1 && (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-text-secondary">
            发现 {discoveredFeeds.length} 个订阅源，请选择：
          </label>
          <div className="max-h-48 space-y-1.5 overflow-y-auto">
            {discoveredFeeds.map((feed) => (
              <button
                key={feed.url}
                type="button"
                onClick={() => handleDiscoveredFeedSelect(feed)}
                disabled={status === "loading"}
                className="flex w-full flex-col gap-0.5 rounded-lg border border-border px-3 py-2 text-left transition-colors hover:border-red/40 hover:bg-red/5 disabled:opacity-50"
              >
                <span className="text-sm font-medium text-text">{feed.title || "(Untitled)"}</span>
                <span className="break-all text-xs text-text-tertiary">{feed.url}</span>
                <span className="text-xs text-text-quaternary">
                  {feed.source === "html-head"
                    ? "HTML <head>"
                    : feed.source === "direct"
                      ? "直接链接"
                      : "常见路径"}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Status Messages */}
      {status === "error" && (
        <div className="rounded-md bg-red/5 px-3 py-2 text-sm text-red">{errorMsg}</div>
      )}
      {status === "success" && (
        <div className="rounded-md bg-green/10 px-3 py-2 text-sm text-green">{successMsg}</div>
      )}

      {/* Action Button */}
      <Button
        onClick={handleSubscribe}
        disabled={
          !input.trim() || status === "loading" || status === "discovering" || isWechatUnconfigured
        }
        buttonClassName="w-full bg-red text-white hover:bg-red/90 disabled:opacity-50"
      >
        {status === "loading"
          ? "订阅中..."
          : status === "discovering"
            ? "发现中..."
            : selectedPlatform.useDiscovery
              ? "发现订阅源"
              : "订阅"}
      </Button>
    </div>
  )
}
