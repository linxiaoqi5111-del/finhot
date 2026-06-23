import { LOCAL_RSS_MODE } from "@follow/shared/constants"

import { followClient } from "~/lib/api-client"
import { defineQuery } from "~/lib/defineQuery"

export const discover = {
  rsshubCategory: ({
    category,
    categories,
    lang,
  }: {
    category?: string
    categories?: string
    lang?: string
  }) =>
    defineQuery(
      ["discover", "rsshub", "category", category, categories, lang],
      async () => {
        if (LOCAL_RSS_MODE) {
          return []
        }

        const res = await followClient.api.discover.rsshub({
          category,
          categories,
          ...(lang !== "all" && { lang }),
        })
        return res.data
      },
      {
        rootKey: ["discover", "rsshub", "category"],
      },
    ),
  rsshubNamespace: ({ namespace }: { namespace: string }) =>
    defineQuery(["discover", "rsshub", "namespace", namespace], async () => {
      if (LOCAL_RSS_MODE) {
        return {}
      }

      const res = await followClient.api.discover.rsshub({
        namespace,
      })
      return res.data
    }),
  rsshubRoute: ({ route }: { route: string }) =>
    defineQuery(["discover", "rsshub", "route", route], async () => {
      if (LOCAL_RSS_MODE) {
        throw new Error("RSSHub route discovery is disabled in local RSS mode")
      }

      const res = await followClient.api.discover.rsshubRoute({
        route,
      })
      return res.data
    }),
  rsshubAnalytics: ({ lang }: { lang?: string }) =>
    defineQuery(["discover", "rsshub", "analytics", lang], async () => {
      if (LOCAL_RSS_MODE) {
        return {}
      }

      const res = await followClient.api.discover.rsshubAnalytics({})
      return res.data
    }),
}
