export const LOCAL_RSS_URL_MESSAGE = "Enter a complete HTTP or HTTPS RSS URL."

export const isSupportedLocalRssUrl = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return false

  // Allow internal finhot:// scheme (e.g. finhot://twitter/elonmusk)
  if (trimmed.startsWith("finhot://")) return true

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false
    }

    const hostname = parsed.hostname.toLowerCase()
    if (!hostname) return false

    return hostname === "localhost" || hostname.includes(".") || hostname.includes(":")
  } catch {
    return false
  }
}
