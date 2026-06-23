import crypto from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { pathToFileURL, URL } from "node:url"

import { env } from "@follow/shared/env.desktop"
import { createBuildSafeHeaders } from "@follow/utils/headers"
import { app } from "electron"
import type { IpcContext } from "electron-ipc-decorator"
import { IpcMethod, IpcService } from "electron-ipc-decorator"
import path from "pathe"

interface ResolveImageInput {
  url: string
  kind?: "icon" | "media"
  width?: number
  height?: number
}

const CACHE_VERSION = "v1"
const IMAGE_FETCH_TIMEOUT_MS = 30_000
const ICON_LINK_RE =
  /<link[^>]+rel=["'][^"']*(?:icon|shortcut icon|apple-touch-icon)[^"']*["'][^>]*>/gi
const HREF_RE = /\shref=["']([^"']+)["']/i

const buildSafeHeaders = createBuildSafeHeaders(env.VITE_WEB_URL, [])

// 将 file:// URL 转换为 app:// URL，避免跨协议访问问题
const fileUrlToAppUrl = (fileUrl: string): string => {
  try {
    const urlObj = new URL(fileUrl)
    if (urlObj.protocol === "file:") {
      return `app://folo.is${urlObj.pathname}`
    }
  } catch {
    // 如果不是有效的 URL，返回原值
  }
  return fileUrl
}

const hashKey = (input: ResolveImageInput) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        ...input,
        width: Math.round(input.width ?? 0),
        height: Math.round(input.height ?? 0),
      }),
    )
    .digest("hex")

const guessExtension = (url: string, contentType?: string | null) => {
  const type = contentType?.split(";")[0]?.trim().toLowerCase()
  if (type === "image/jpeg") return ".jpg"
  if (type === "image/png") return ".png"
  if (type === "image/gif") return ".gif"
  if (type === "image/webp") return ".webp"
  if (type === "image/svg+xml") return ".svg"
  if (type === "image/x-icon" || type === "image/vnd.microsoft.icon") return ".ico"

  try {
    const ext = path.extname(new URL(url).pathname)
    return ext || ".img"
  } catch {
    return ".img"
  }
}

const parseHttpUrl = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return url
  } catch {
    return null
  }
}

const findIconUrlFromHtml = (html: string, baseUrl: string) => {
  const candidates = html.match(ICON_LINK_RE) ?? []
  for (const candidate of candidates) {
    const href = HREF_RE.exec(candidate)?.[1]
    if (!href) continue
    try {
      return new URL(href, baseUrl).href
    } catch {
      continue
    }
  }
  return null
}

export class ImageService extends IpcService {
  static override readonly groupName = "image"

  @IpcMethod()
  async resolve(_context: IpcContext, input: ResolveImageInput): Promise<string | null> {
    const parsedUrl = parseHttpUrl(input.url)
    if (!parsedUrl) return null

    const cacheDir = path.join(
      app.getPath("userData"),
      "Cache",
      "images",
      CACHE_VERSION,
      input.kind ?? "media",
    )
    const key = hashKey(input)
    const existing = await this.readExistingCache(cacheDir, key)
    if (existing) return existing

    const sourceUrl =
      input.kind === "icon" ? await this.resolveIconSource(parsedUrl) : parsedUrl.href
    if (!sourceUrl) return null

    return this.fetchAndCache(sourceUrl, cacheDir, key)
  }

  private async readExistingCache(cacheDir: string, key: string) {
    const metadataPath = path.join(cacheDir, `${key}.json`)
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { fileName?: string }
      if (!metadata.fileName) return null
      const fileUrl = pathToFileURL(path.join(cacheDir, metadata.fileName)).href
      return fileUrlToAppUrl(fileUrl)
    } catch {
      return null
    }
  }

  private async resolveIconSource(siteUrl: URL) {
    try {
      const response = await this.fetchWithTimeout(siteUrl.href, {
        headers: buildSafeHeaders({ url: siteUrl.href }),
      })
      const contentType = response.headers.get("content-type")
      if (contentType?.startsWith("image/")) {
        return siteUrl.href
      }
      const html = await response.text()
      return findIconUrlFromHtml(html, siteUrl.href) ?? new URL("/favicon.ico", siteUrl.origin).href
    } catch {
      return new URL("/favicon.ico", siteUrl.origin).href
    }
  }

  private async fetchAndCache(url: string, cacheDir: string, key: string) {
    const response = await this.fetchWithTimeout(url, {
      headers: buildSafeHeaders({ url }),
    })

    if (!response.ok) return null

    const contentType = response.headers.get("content-type")
    if (!contentType?.startsWith("image/")) return null

    const ext = guessExtension(url, contentType)
    const fileName = `${key}${ext}`
    await mkdir(cacheDir, { recursive: true })
    await writeFile(path.join(cacheDir, fileName), Buffer.from(await response.arrayBuffer()))
    await writeFile(
      path.join(cacheDir, `${key}.json`),
      JSON.stringify({ fileName, url, contentType }),
    )

    const fileUrl = pathToFileURL(path.join(cacheDir, fileName)).href
    return fileUrlToAppUrl(fileUrl)
  }

  private async fetchWithTimeout(url: string, init: RequestInit) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS)
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }
}
