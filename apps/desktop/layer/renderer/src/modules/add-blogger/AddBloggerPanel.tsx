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
  fetchAccountNameAfterAdd,
  isWechat2rssConfigured,
  resolveAccountByName,
  searchAccountsByName,
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
    buildUrl: (uid: string) => `finhot://xueqiu/${uid.trim()}`,
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
    id: "wechat",
    label: "公众号",
    icon: "🟢",
    placeholder: "输入公众号名称、文章链接或 ID",
    hint: "输入名称搜索已订阅列表，或粘贴文章链接添加新订阅",
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

interface WechatSearchResult {
  id: number
  name: string
  link: string
}

type SubscribeStatus = "idle" | "loading" | "resolving" | "success" | "error" | "discovering"

export function AddBloggerPanel({ onClose }: { onClose?: () => void }) {
  const [selectedPlatform, setSelectedPlatform] = useState<Platform>(PLATFORMS[0]!)
  const [input, setInput] = useState("")
  const [status, setStatus] = useState<SubscribeStatus>("idle")
  const [errorMsg, setErrorMsg] = useState("")
  const [successMsg, setSuccessMsg] = useState("")
  const [discoveredFeeds, setDiscoveredFeeds] = useState<DiscoveredFeed[]>([])
  const [wechatSearchResults, setWechatSearchResults] = useState<WechatSearchResult[]>([])
  const [showWechatSearchHint, setShowWechatSearchHint] = useState(false)

  const wechat2rssEnabled = useIntegrationSettingKey("enableWechat2rss")

  const isWechatUrl = (s: string) =>
    s.startsWith("http://mp.weixin.qq.com") || s.startsWith("https://mp.weixin.qq.com")
  const isWechatBizId = (s: string) => /^\d{5,}$/.test(s)

  const handleWechat2rssSubscribe = useCallback(async (trimmed: string) => {
    if (!isWechat2rssConfigured()) {
      throw new Error("wechat2rss 未配置。请在设置 > 集成中填写服务地址和 Token。")
    }

    // Detect input type: URL, biz ID, or name search
    const isUrl = isWechatUrl(trimmed)
    const isBizId = isWechatBizId(trimmed)

    if (!isUrl && !isBizId) {
      // Name search: check existing subscriptions first
      const results = await searchAccountsByName(trimmed)
      if (results.length > 0) {
        setWechatSearchResults(results)
        setShowWechatSearchHint(false)
        setStatus("idle")
        return null // Signal: show results instead of subscribing
      }

      // No existing match — try resolving name → biz ID via Sogou search
      setStatus("resolving")
      const resolved = await resolveAccountByName(trimmed)
      if (resolved) {
        // Found the account! Subscribe using the biz ID
        const feedUrl = await addAccountById(resolved.bizId)
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
            title: feedData.title || resolved.nickname || `公众号 - ${trimmed}`,
            feedId: feedData.id,
            listId: undefined,
          },
        })

        return feedData.title || trimmed
      }

      // Resolution failed — show manual guidance
      setWechatSearchResults([])
      setShowWechatSearchHint(true)
      setStatus("idle")
      window.open(
        `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(trimmed)}`,
        "_blank",
        "noopener,noreferrer",
      )
      return null
    }

    const feedUrl = isUrl ? await addAccountByUrl(trimmed) : await addAccountById(trimmed)

    // Query wechat2rss list to get the account name (more reliable than feed XML title)
    const accountName = await fetchAccountNameAfterAdd(feedUrl)

    // Subscribe to the returned feed URL
    const preview = await previewLocalRssFeed({ url: feedUrl })
    const feedData = preview.feed

    const title = accountName || feedData.title || "微信公众号 (同步中)"

    await upsertLocalRssSubscription({
      feed: { ...feedData, type: "feed" as const },
      subscription: {
        url: feedUrl,
        view: FeedViewType.Articles,
        category: "公众号",
        isPrivate: false,
        hideFromTimeline: null,
        title,
        feedId: feedData.id,
        listId: undefined,
      },
    })

    return title
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
      let title: string | null

      if (selectedPlatform.useWechat2rss) {
        title = await handleWechat2rssSubscribe(trimmed)
        if (title === null) return // Search results shown, no subscribe yet
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
      setSuccessMsg(`已订阅：${title!}`)
      setInput("")
      setWechatSearchResults([])
      setShowWechatSearchHint(false)
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
                setWechatSearchResults([])
                setShowWechatSearchHint(false)
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
            setWechatSearchResults([])
            setShowWechatSearchHint(false)
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

      {/* WeChat search results (from existing subscriptions) */}
      {wechatSearchResults.length > 0 && (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-text-secondary">
            已订阅中匹配到 {wechatSearchResults.length} 个公众号：
          </label>
          <div className="max-h-48 space-y-1.5 overflow-y-auto">
            {wechatSearchResults.map((account) => (
              <button
                key={account.id}
                type="button"
                onClick={() => {
                  setInput(String(account.id))
                  setWechatSearchResults([])
                  setShowWechatSearchHint(false)
                }}
                className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2 text-left transition-colors hover:border-red/40 hover:bg-red/5"
              >
                <span className="text-sm font-medium text-text">{account.name}</span>
                <span className="text-xs text-text-quaternary">ID: {account.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* WeChat name search hint — shown when no match in existing subscriptions */}
      {showWechatSearchHint && (
        <div className="flex flex-col gap-2.5 rounded-md border border-orange/20 bg-orange/5 px-3 py-2.5">
          <p className="text-sm font-medium text-text-secondary">
            已在搜狗打开搜索结果，请完成以下步骤：
          </p>
          <ol className="list-inside list-decimal space-y-1.5 text-sm text-text-tertiary">
            <li>在搜狗页面找到目标公众号的文章</li>
            <li>
              复制文章链接
              <span className="text-text-quaternary"> （形如 mp.weixin.qq.com/s/...）</span>
            </li>
            <li>粘贴到上方输入框，点击订阅</li>
          </ol>
          <a
            href={`https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(input)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-red hover:text-red/80"
          >
            重新打开搜索
            <svg className="size-3" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8.22 2.97a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06l2.97-2.97H3.75a.75.75 0 0 1 0-1.5h7.44L8.22 4.03a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </a>
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
          !input.trim() ||
          status === "loading" ||
          status === "resolving" ||
          status === "discovering" ||
          isWechatUnconfigured
        }
        buttonClassName="w-full bg-red text-white hover:bg-red/90 disabled:opacity-50"
      >
        {status === "loading"
          ? "订阅中..."
          : status === "resolving"
            ? "正在搜索公众号..."
            : status === "discovering"
              ? "发现中..."
              : selectedPlatform.useDiscovery
                ? "发现订阅源"
                : selectedPlatform.useWechat2rss &&
                    input.trim() &&
                    !isWechatUrl(input.trim()) &&
                    !isWechatBizId(input.trim())
                  ? "搜索"
                  : "订阅"}
      </Button>
    </div>
  )
}
