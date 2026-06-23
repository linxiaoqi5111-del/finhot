import { useEffect, useState } from "react"

import { ipcServices } from "./client"

export interface LocalImageOptions {
  kind?: "icon" | "media"
  width?: number
  height?: number
  enabled?: boolean
}

export const resolveLocalImageUrl = async (url: string, options: LocalImageOptions = {}) => {
  if (options.enabled === false || !window.electron || !ipcServices?.image) {
    return url
  }

  try {
    return (
      (await ipcServices.image.resolve({
        url,
        kind: options.kind,
        width: options.width,
        height: options.height,
      })) || url
    )
  } catch {
    return url
  }
}

export const useLocalImageUrl = (url?: string | null, options: LocalImageOptions = {}) => {
  const [resolvedUrl, setResolvedUrl] = useState(url)
  const { enabled, height, kind, width } = options

  useEffect(() => {
    let cancelled = false
    setResolvedUrl(url)

    if (!url || enabled === false) {
      return
    }

    resolveLocalImageUrl(url, { enabled, height, kind, width }).then((nextUrl) => {
      if (!cancelled) {
        setResolvedUrl(nextUrl)
      }
    })

    return () => {
      cancelled = true
    }
  }, [enabled, height, kind, width, url])

  return resolvedUrl
}
