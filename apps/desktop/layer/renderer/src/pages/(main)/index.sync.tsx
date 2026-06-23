import { redirect } from "react-router"

import { ROUTE_ENTRY_PENDING, ROUTE_VIEW_ALL } from "~/constants"
import { SMART_FEED_TODAY } from "~/lib/timeline-scope"

const VISITOR_CHECKED_KEY = "finhot:visitor-mode-checked"

export function Component() {
  return null
}

export const loader = async () => {
  // If the user has previously loaded local data, go to the normal timeline
  if (localStorage.getItem(VISITOR_CHECKED_KEY) === "owner") {
    return redirect(`/timeline/${ROUTE_VIEW_ALL}/${SMART_FEED_TODAY}/${ROUTE_ENTRY_PENDING}`)
  }

  // Check if there are local subscriptions (seeded flag or explicit data)
  const hasLocalData =
    localStorage.getItem("local-rss:default-feeds-seeded") === "1" ||
    localStorage.getItem(VISITOR_CHECKED_KEY) === "owner"

  if (hasLocalData) {
    localStorage.setItem(VISITOR_CHECKED_KEY, "owner")
    return redirect(`/timeline/${ROUTE_VIEW_ALL}/${SMART_FEED_TODAY}/${ROUTE_ENTRY_PENDING}`)
  }

  // No local data — check if public API has data (visitor mode)
  try {
    const res = await fetch("/api/public/subscriptions", { signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      const { feeds } = await res.json()
      if (feeds && feeds.length > 0) {
        return redirect("/public")
      }
    }
  } catch {
    // API not available or timeout — fall through to normal app
  }

  // No public data either — show normal app (first-time owner)
  localStorage.setItem(VISITOR_CHECKED_KEY, "owner")
  return redirect(`/timeline/${ROUTE_VIEW_ALL}/${SMART_FEED_TODAY}/${ROUTE_ENTRY_PENDING}`)
}
