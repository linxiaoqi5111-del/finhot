/**
 * AddBloggerPanel — select platform + enter username to auto-generate RSSHub URL and subscribe.
 */

import { Button } from "@follow/components/ui/button/index.js"
import { FeedViewType, LOCAL_RSSHUB_BASE } from "@follow/constants"
import { cn } from "@follow/utils/utils"
import { useCallback, useState } from "react"

import { previewLocalRssFeed, upsertLocalRssSubscription } from "~/modules/local-rss/service"

interface Platform {
  id: string
  label: string
  icon: string
  placeholder: string
  hint: string
  buildUrl: (input: string) => string
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
    placeholder: "输入用户名（如 elonmusk）",
    hint: "需要 RSSHub 配置 Twitter Cookie",
    buildUrl: (handle: string) =>
      `${LOCAL_RSSHUB_BASE}/twitter/user/${handle.trim().replace(/^@/, "")}`,
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
    placeholder: "输入公众号 ID（如 wxnmh015）",
    hint: "需要 RSSHub 配置 WeChat Cookie 或使用第三方服务",
    buildUrl: (id: string) => `${LOCAL_RSSHUB_BASE}/wechat/mp/profile/${id.trim()}`,
  },
]

type SubscribeStatus = "idle" | "loading" | "success" | "error"

export function AddBloggerPanel({ onClose }: { onClose?: () => void }) {
  const [selectedPlatform, setSelectedPlatform] = useState<Platform>(PLATFORMS[0]!)
  const [input, setInput] = useState("")
  const [status, setStatus] = useState<SubscribeStatus>("idle")
  const [errorMsg, setErrorMsg] = useState("")
  const [successMsg, setSuccessMsg] = useState("")

  const handleSubscribe = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed) return

    setStatus("loading")
    setErrorMsg("")
    setSuccessMsg("")

    const url = selectedPlatform.buildUrl(trimmed)

    try {
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
      setStatus("success")
      setSuccessMsg(`已订阅：${feedData.title || trimmed}`)
      setInput("")
    } catch (error) {
      setStatus("error")
      const msg = error instanceof Error ? error.message : "订阅失败"
      setErrorMsg(msg)
    }
  }, [input, selectedPlatform])

  return (
    <div className="flex w-full max-w-[560px] flex-col gap-5 rounded-xl border border-border bg-background p-6 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text">添加博主</h2>
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
        <label className="mb-2 block text-sm font-medium text-text-secondary">选择平台</label>
        <div className="grid grid-cols-3 gap-2">
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
              }}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                selectedPlatform.id === platform.id
                  ? "border-red/40 bg-red/5 font-medium text-text"
                  : "border-border bg-fill-quaternary text-text-secondary hover:border-fill-tertiary",
              )}
            >
              <span>{platform.icon}</span>
              <span>{platform.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Input */}
      <div>
        <label className="mb-2 block text-sm font-medium text-text-secondary">
          {selectedPlatform.label} 用户标识
        </label>
        <input
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setStatus("idle")
            setErrorMsg("")
            setSuccessMsg("")
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) {
              handleSubscribe()
            }
          }}
          placeholder={selectedPlatform.placeholder}
          className="w-full rounded-lg border border-border bg-fill-quaternary px-4 py-2.5 text-sm text-text placeholder:text-text-quaternary focus:border-red/40 focus:outline-none focus:ring-1 focus:ring-red/20"
        />
        <p className="mt-1.5 text-xs text-text-tertiary">{selectedPlatform.hint}</p>
      </div>

      {/* Generated URL Preview */}
      {input.trim() && (
        <div className="rounded-md bg-fill-secondary px-3 py-2">
          <span className="text-xs text-text-tertiary">RSS 地址：</span>
          <code className="mt-0.5 block break-all text-xs text-text-secondary">
            {selectedPlatform.buildUrl(input)}
          </code>
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
        disabled={!input.trim() || status === "loading"}
        buttonClassName="w-full bg-red text-white hover:bg-red/90 disabled:opacity-50"
      >
        {status === "loading" ? "订阅中..." : "订阅博主"}
      </Button>
    </div>
  )
}
