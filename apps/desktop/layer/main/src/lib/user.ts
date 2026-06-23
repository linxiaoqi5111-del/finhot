import type { Credentials } from "@eneris/push-receiver/dist/types"
import { LOCAL_RSS_MODE } from "@follow/shared/constants"

import { isLinux, isMacOS, isWindows } from "~/env"
import { logger } from "~/logger"

import { apiClient } from "./api-client"
import { store } from "./store"

const notificationChannel = isMacOS
  ? "macos"
  : isWindows
    ? "windows"
    : isLinux
      ? "linux"
      : "desktop"

export const updateNotificationsToken = async (newCredentials?: Credentials) => {
  if (LOCAL_RSS_MODE) return

  if (newCredentials) {
    store.set("notifications-credentials", newCredentials)
  }
  const credentials = newCredentials || store.get("notifications-credentials")
  if (credentials?.fcm?.token) {
    try {
      await apiClient.messaging.createToken({
        token: credentials.fcm.token,
        channel: notificationChannel,
      })
      logger.info("updateNotificationsToken success: ", credentials.fcm.token)
    } catch (error) {
      logger.error("updateNotificationsToken error: ", error)
    }
  }
}

export const deleteNotificationsToken = async () => {
  if (LOCAL_RSS_MODE) return

  await apiClient.messaging.deleteToken({
    channel: notificationChannel,
  })
}
