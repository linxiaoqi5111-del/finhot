import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { useEffect } from "react"

import { useGeneralSettingKey } from "~/atoms/settings/general"
import { ElectronShowEvent } from "~/providers/invalidate-query-provider"

import {
  RSS_STARTUP_REFRESH_DELAY_MS,
  runLocalRssRefresh,
  runLocalRssStartup,
  shouldRefreshLocalRssFeeds,
} from "./refresh-scheduler"

export const LocalRssAutoRefreshProvider = () => {
  const autoRefreshRss = useGeneralSettingKey("autoRefreshRss")
  const intervalMinutes = useGeneralSettingKey("autoRefreshRssIntervalMinutes")
  const autoRefreshRssOnWake = useGeneralSettingKey("autoRefreshRssOnWake")

  useEffect(() => {
    if (!LOCAL_RSS_MODE) return

    void runLocalRssStartup()

    const startupTimer = setTimeout(() => {
      if (shouldRefreshLocalRssFeeds()) {
        void runLocalRssRefresh("startup")
      }
    }, RSS_STARTUP_REFRESH_DELAY_MS)

    return () => clearTimeout(startupTimer)
  }, [])

  useEffect(() => {
    if (!LOCAL_RSS_MODE || !autoRefreshRss) return

    const intervalMs = intervalMinutes * 60 * 1000
    const timer = setInterval(() => {
      void runLocalRssRefresh("interval")
    }, intervalMs)

    return () => clearInterval(timer)
  }, [autoRefreshRss, intervalMinutes])

  useEffect(() => {
    if (!LOCAL_RSS_MODE) return

    const handler = () => {
      if (!autoRefreshRssOnWake || !autoRefreshRss) return
      if (!shouldRefreshLocalRssFeeds()) return
      void runLocalRssRefresh("wake")
    }

    document.addEventListener(ElectronShowEvent.type, handler)

    return () => {
      document.removeEventListener(ElectronShowEvent.type, handler)
    }
  }, [autoRefreshRssOnWake, autoRefreshRss, intervalMinutes])

  return null
}
