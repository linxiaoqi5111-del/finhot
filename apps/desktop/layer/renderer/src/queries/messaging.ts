import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { useMutation } from "@tanstack/react-query"

import { useAuthQuery } from "~/hooks/common"
import { followClient } from "~/lib/api-client"
import { defineQuery } from "~/lib/defineQuery"

export const messaging = {
  list: () =>
    defineQuery(
      ["messaging"],
      () => {
        if (LOCAL_RSS_MODE) {
          return { data: [] }
        }

        return followClient.api.messaging.getTokens()
      },
      {
        rootKey: ["messaging"],
      },
    ),
}

export const useMessaging = () => useAuthQuery(messaging.list(), { enabled: !LOCAL_RSS_MODE })

export const useTestMessaging = () =>
  useMutation({
    mutationFn: ({ channel }: { channel: string }) => {
      if (LOCAL_RSS_MODE) {
        return Promise.reject(new Error("Messaging is disabled in local RSS mode"))
      }

      return followClient.api.messaging.testNotification({ channel })
    },
  })
