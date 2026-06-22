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
 * Delete a WeChat public account subscription by its biz ID.
 */
export const deleteAccount = async (bizId: string): Promise<void> => {
  await apiFetch(`/del/${encodeURIComponent(bizId.trim())}`)
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
