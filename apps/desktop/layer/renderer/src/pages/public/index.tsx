import { useCallback, useEffect, useMemo, useRef, useState } from "react"

// ─── Types ───

interface PublicFeed {
  id: string
  title: string | null
  url: string
  description: string | null
  image: string | null
  siteUrl: string | null
  category: string | null
  updatedAt: string
}

interface PublicEntry {
  id: string
  title: string | null
  url: string | null
  content: string
  description: string | null
  author: string | null
  publishedAt: string
  feedId: string
}

// ─── API helpers ───

const API_BASE = import.meta.env.VITE_PUBLIC_API_BASE ?? ""

async function fetchPublicSubscriptions(): Promise<{ feeds: PublicFeed[] }> {
  const res = await fetch(`${API_BASE}/api/public/subscriptions`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function fetchPublicEntries(
  feedId?: string,
  limit = 30,
): Promise<{ entries: PublicEntry[] }> {
  const params = new URLSearchParams()
  if (feedId) params.set("feedId", feedId)
  params.set("limit", String(limit))
  const res = await fetch(`${API_BASE}/api/public/entries?${params}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// ─── Helpers ───

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前`
  return new Date(dateStr).toLocaleDateString("zh-CN")
}

function stripHtml(html: string): string {
  const tmp = document.createElement("div")
  tmp.innerHTML = html
  return tmp.textContent ?? ""
}

const CAT_ORDER = ["微博", "推特", "雪球", "公众号", "其他"]

function groupByCategory(feeds: PublicFeed[]): [string, PublicFeed[]][] {
  const groups = new Map<string, PublicFeed[]>()
  for (const feed of feeds) {
    const cat = feed.category ?? "其他"
    const existing = groups.get(cat)
    if (existing) existing.push(feed)
    else groups.set(cat, [feed])
  }
  return [...groups.entries()].sort((a, b) => {
    const ia = CAT_ORDER.indexOf(a[0])
    const ib = CAT_ORDER.indexOf(b[0])
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })
}

// ─── Components ───

function FeedIcon({ feed }: { feed: PublicFeed }) {
  const [error, setError] = useState(false)

  if (feed.image && !error) {
    return (
      <img
        src={feed.image}
        alt=""
        className="size-5 shrink-0 rounded"
        onError={() => setError(true)}
      />
    )
  }

  // Twitter icon
  if (feed.url.startsWith("finhot://twitter/")) {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded bg-neutral-900 text-[10px] font-bold text-white dark:bg-neutral-100 dark:text-neutral-900">
        𝕏
      </span>
    )
  }

  // Fallback initial
  const initial = (feed.title ?? "?").charAt(0).toUpperCase()
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded bg-neutral-200 text-[10px] font-semibold text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
      {initial}
    </span>
  )
}

function EntryCard({ entry, feedTitle }: { entry: PublicEntry; feedTitle?: string }) {
  const snippet = useMemo(
    () => stripHtml(entry.description ?? entry.content ?? "").slice(0, 200),
    [entry.description, entry.content],
  )

  return (
    <a
      href={entry.url ?? "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="group block rounded-xl border border-neutral-200/60 bg-white/80 p-4 transition-all duration-200 hover:border-neutral-300 hover:shadow-sm dark:border-neutral-700/60 dark:bg-neutral-800/80 dark:hover:border-neutral-600"
    >
      <div className="mb-1.5 flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        {feedTitle && <span className="font-medium">{feedTitle}</span>}
        {feedTitle && <span>·</span>}
        <span>{timeAgo(entry.publishedAt)}</span>
        {entry.author && (
          <>
            <span>·</span>
            <span>{entry.author}</span>
          </>
        )}
      </div>
      {entry.title && (
        <h3 className="mb-1 text-sm font-semibold leading-snug text-neutral-900 group-hover:text-blue-600 dark:text-neutral-100 dark:group-hover:text-blue-400">
          {entry.title}
        </h3>
      )}
      {snippet && (
        <p className="line-clamp-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          {snippet}
        </p>
      )}
    </a>
  )
}

// ─── Main Component ───

export function Component() {
  const [feeds, setFeeds] = useState<PublicFeed[]>([])
  const [entries, setEntries] = useState<PublicEntry[]>([])
  const [selectedFeedId, setSelectedFeedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const mainRef = useRef<HTMLDivElement>(null)

  // Load subscriptions
  useEffect(() => {
    fetchPublicSubscriptions()
      .then(({ feeds: f }) => setFeeds(f))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  // Load entries when feed changes
  useEffect(() => {
    setEntries([])
    fetchPublicEntries(selectedFeedId ?? undefined, 50)
      .then(({ entries: e }) => setEntries(e))
      .catch(() => {})
  }, [selectedFeedId])

  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>({})
  const grouped = useMemo(() => groupByCategory(feeds), [feeds])

  const feedById = useMemo(() => {
    const map = new Map<string, PublicFeed>()
    for (const f of feeds) map.set(f.id, f)
    return map
  }, [feeds])

  const handleFeedClick = useCallback((feedId: string | null) => {
    setSelectedFeedId((prev) => (prev === feedId ? null : feedId))
    if (mainRef.current) mainRef.current.scrollTop = 0
  }, [])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-50 dark:bg-neutral-900">
        <div className="flex flex-col items-center gap-3">
          <div className="size-6 animate-spin rounded-full border-2 border-neutral-300 border-t-blue-500" />
          <span className="text-sm text-neutral-500">加载中...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-50 dark:bg-neutral-900">
        <div className="text-center">
          <p className="mb-2 text-lg font-medium text-neutral-700 dark:text-neutral-300">
            暂无公开数据
          </p>
          <p className="text-sm text-neutral-500">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen bg-neutral-100 dark:bg-neutral-900">
      {/* Sidebar */}
      <aside
        className={`${sidebarOpen ? "w-72" : "w-0"} flex shrink-0 flex-col overflow-hidden border-r border-neutral-200/60 bg-white/90 backdrop-blur-xl transition-all duration-300 dark:border-neutral-800/60 dark:bg-neutral-800/90`}
      >
        {/* Header */}
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-neutral-200/60 px-4 dark:border-neutral-700/60">
          <span className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            FinHot
          </span>
          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
            {feeds.length} 订阅
          </span>
        </div>

        {/* Feed list */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {/* All feeds button */}
          <button
            type="button"
            onClick={() => handleFeedClick(null)}
            className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
              selectedFeedId === null
                ? "bg-blue-50 font-medium text-blue-700 dark:bg-blue-900/20 dark:text-blue-400"
                : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700/50"
            }`}
          >
            <span className="flex size-5 shrink-0 items-center justify-center">
              <i className="i-focal-radar size-4" />
            </span>
            <span>全部</span>
          </button>

          {/* Grouped feeds */}
          {grouped.map(([category, categoryFeeds]) => {
            const isCollapsed = !!collapsedCats[category]
            return (
              <div key={category} className="mb-1">
                <button
                  type="button"
                  onClick={() =>
                    setCollapsedCats((prev) => ({
                      ...prev,
                      [category]: !prev[category],
                    }))
                  }
                  className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={`shrink-0 text-neutral-400 transition-transform duration-150 dark:text-neutral-500 ${
                      isCollapsed ? "-rotate-90" : ""
                    }`}
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                  <span className="text-[11px] font-semibold text-neutral-500 dark:text-neutral-400">
                    {category}
                  </span>
                  <span className="ml-auto text-[10px] text-neutral-400 dark:text-neutral-500">
                    {categoryFeeds.length}
                  </span>
                </button>
                {!isCollapsed &&
                  categoryFeeds.map((feed) => (
                    <button
                      key={feed.id}
                      type="button"
                      onClick={() => handleFeedClick(feed.id)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                        selectedFeedId === feed.id
                          ? "bg-blue-50 font-medium text-blue-700 dark:bg-blue-900/20 dark:text-blue-400"
                          : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700/50"
                      }`}
                    >
                      <FeedIcon feed={feed} />
                      <span className="truncate">{feed.title ?? feed.url}</span>
                    </button>
                  ))}
              </div>
            )
          })}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-200/60 px-4 dark:border-neutral-800/60">
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            className="flex size-8 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <h1 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {selectedFeedId ? (feedById.get(selectedFeedId)?.title ?? "订阅") : "全部文章"}
          </h1>
          <span className="text-xs text-neutral-400">{entries.length} 条</span>
        </div>

        {/* Entries */}
        <div ref={mainRef} className="flex-1 overflow-y-auto p-4">
          {entries.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-neutral-400">暂无内容</p>
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-2">
              {entries.map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  feedTitle={
                    selectedFeedId ? undefined : (feedById.get(entry.feedId)?.title ?? undefined)
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
