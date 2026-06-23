/**
 * wechat2rss API client for private deployment.
 *
 * API reference: https://wechat2rss.xlab.app/deploy/api.html
 *
 * All mutating endpoints require `?k=<RSS_TOKEN>`.
 * Feed URLs (`/feed/:id.xml`) are public (the hash IS the auth).
 */

import { getIntegrationSettings } from "~/atoms/settings/integration"

interface Wechat2rssConfig {
  endpoint: string
  token: string
}

interface Wechat2rssListItem {
  id: number
  name: string
  link: string
}

interface Wechat2rssListResponse {
  err: string
  data: Wechat2rssListItem[]
  meta?: { total: number }
}

interface Wechat2rssAddResponse {
  err: string
  data: string
}

const getConfig = (): Wechat2rssConfig | null => {
  const settings = getIntegrationSettings()
  if (!settings.enableWechat2rss || !settings.wechat2rssEndpoint || !settings.wechat2rssToken) {
    return null
  }
  return {
    endpoint: settings.wechat2rssEndpoint.replace(/\/+$/, ""),
    token: settings.wechat2rssToken,
  }
}

export const isWechat2rssConfigured = (): boolean => getConfig() !== null

const apiFetch = async <T>(path: string, _options?: RequestInit): Promise<T> => {
  const config = getConfig()
  if (!config) {
    throw new Error("wechat2rss 未配置。请在设置 > 集成中填写服务地址和 Token。")
  }

  const sep = path.includes("?") ? "&" : "?"
  const targetUrl = `${config.endpoint}${path}${sep}k=${encodeURIComponent(config.token)}`

  // Route through server-side proxy to bypass CORS restrictions.
  // The wechat2rss service typically runs on a different port (e.g. localhost:8090)
  // and does not set Access-Control-Allow-Origin headers.
  const res = await fetch("/api/wechat2rss/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: targetUrl }),
  })

  if (!res.ok) {
    throw new Error(`wechat2rss API error: HTTP ${res.status}`)
  }

  const json = (await res.json()) as { err?: string; error?: string; data?: unknown }
  if (json.error) {
    throw new Error(`wechat2rss: ${json.error}`)
  }
  if (json.err) {
    throw new Error(`wechat2rss: ${json.err}`)
  }

  return json as T
}

/**
 * List all subscribed WeChat public accounts.
 * Supports pagination via `page` / `size` and filtering via `name`.
 */
export const listAccounts = async (params?: {
  page?: number
  size?: number
  name?: string
}): Promise<{ items: Wechat2rssListItem[]; total: number }> => {
  const searchParams = new URLSearchParams()
  if (params?.page) searchParams.set("page", String(params.page))
  if (params?.size) searchParams.set("size", String(params.size))
  if (params?.name) searchParams.set("name", params.name)

  const qs = searchParams.toString()
  const path = `/list${qs ? `?${qs}` : ""}`

  const res = await apiFetch<Wechat2rssListResponse>(path)
  return {
    items: res.data || [],
    total: res.meta?.total ?? (res.data?.length || 0),
  }
}

/**
 * Add a WeChat public account subscription by its biz ID.
 * Returns the RSS feed URL.
 */
export const addAccountById = async (bizId: string): Promise<string> => {
  const res = await apiFetch<Wechat2rssAddResponse>(`/add/${encodeURIComponent(bizId.trim())}`)
  return res.data
}

/**
 * Add a WeChat public account subscription by an article URL.
 * The service extracts the biz ID from the article automatically.
 * Returns the RSS feed URL.
 */
export const addAccountByUrl = async (articleUrl: string): Promise<string> => {
  const res = await apiFetch<Wechat2rssAddResponse>(
    `/addurl?url=${encodeURIComponent(articleUrl.trim())}`,
  )
  return res.data
}

/**
 * After adding an account (by URL or biz ID), query the wechat2rss list to find
 * the account name. Returns the name if found, or null.
 */
export const fetchAccountNameAfterAdd = async (feedUrl: string): Promise<string | null> => {
  try {
    const { items } = await listAccounts({ page: 1, size: 20 })
    if (items.length === 0) return null

    // Try to match by feed URL path (e.g. "/feed/<hash>.xml")
    const feedPath = feedUrl.replace(/^https?:\/\/[^/]+/, "")
    const match = items.find((item) => item.link && item.link.includes(feedPath))
    if (match) return match.name

    // Fallback: return the most recently added account (last in list or first by ID desc)
    const sorted = [...items].sort((a, b) => b.id - a.id)
    return sorted[0]?.name ?? null
  } catch {
    return null
  }
}

/**
 * Delete a WeChat public account subscription by its biz ID.
 */
export const deleteAccount = async (bizId: string): Promise<void> => {
  await apiFetch(`/del/${encodeURIComponent(bizId.trim())}`)
}

/**
 * Search for a WeChat public account by name among already-subscribed accounts.
 * Uses the wechat2rss `/list?name=xxx` filter.
 */
export const searchAccountsByName = async (name: string): Promise<Wechat2rssListItem[]> => {
  const res = await apiFetch<Wechat2rssListResponse>(`/list?name=${encodeURIComponent(name)}`)
  return res.data || []
}

interface ResolveNameResponse {
  found: boolean
  bizId?: string
  nickname?: string
  articleUrl?: string
  error?: string
}

/**
 * Resolve a WeChat public account name to its numeric biz ID.
 * Uses the server-side proxy which searches Sogou and extracts biz from article pages.
 */
export const resolveAccountByName = async (
  name: string,
): Promise<{ bizId: string; nickname: string; articleUrl: string } | null> => {
  const res = await fetch("/api/wechat2rss/resolve-name", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })

  if (!res.ok) {
    throw new Error(`Name resolution failed: HTTP ${res.status}`)
  }

  const data = (await res.json()) as ResolveNameResponse
  if (data.error) {
    throw new Error(`Name resolution: ${data.error}`)
  }

  if (!data.found || !data.bizId) return null
  return { bizId: data.bizId, nickname: data.nickname ?? name, articleUrl: data.articleUrl ?? "" }
}

/**
 * Build the RSS feed URL for a subscribed account.
 * Feed URLs do not need authentication.
 */
export const buildFeedUrl = (endpoint: string, feedPath: string): string => {
  const base = endpoint.replace(/\/+$/, "")
  const path = feedPath.startsWith("/") ? feedPath : `/${feedPath}`
  return `${base}${path}`
}
