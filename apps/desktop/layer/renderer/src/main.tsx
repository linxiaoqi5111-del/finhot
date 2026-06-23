import "./wdyr"
import "@follow/components/tailwind"
import "./styles/main.css"

import { IN_ELECTRON, LOCAL_RSS_MODE, WEB_BUILD } from "@follow/shared/constants"
import {
  apiContext,
  authClientContext,
  embeddingGeneratorContext,
  qualityScoreGeneratorContext,
  queryClientContext,
  readabilityContentFetcherContext,
  summaryGeneratorContext,
  tagGeneratorContext,
  translationGeneratorContext,
} from "@follow/store/context"
import { getOS } from "@follow/utils/utils"
import * as React from "react"
import { flushSync } from "react-dom"
import ReactDOM from "react-dom/client"
import { RouterProvider } from "react-router/dom"

import { authClient } from "~/lib/auth"

import { setAppIsReady } from "./atoms/app"
import { ElECTRON_CUSTOM_TITLEBAR_HEIGHT } from "./constants"
import { fetchEntryReadabilityContentFromSource } from "./hooks/biz/readability-content"
import { initializeApp } from "./initialize"
import { registerAppGlobalShortcuts } from "./initialize/global-shortcuts"
import { followApi } from "./lib/api-client"
import { queryClient } from "./lib/query-client"
import { generateLocalByokQualityScore } from "./modules/ai/local-byok-quality-score"
import { generateLocalByokSummary } from "./modules/ai/local-byok-summary"
import { generateLocalByokTags } from "./modules/ai/local-byok-tags"
import { generateLocalByokTranslation } from "./modules/ai/local-byok-translation"
import { generateLocalEmbedding } from "./modules/ai/local-embedding"
import { router } from "./router"

authClientContext.provide(authClient)
queryClientContext.provide(queryClient)
apiContext.provide(followApi)
readabilityContentFetcherContext.provide(({ entryId, url }) =>
  fetchEntryReadabilityContentFromSource({ id: entryId, url }),
)
if (LOCAL_RSS_MODE) {
  summaryGeneratorContext.provide(generateLocalByokSummary)
  translationGeneratorContext.provide(generateLocalByokTranslation)
  tagGeneratorContext.provide(generateLocalByokTags)
  qualityScoreGeneratorContext.provide(generateLocalByokQualityScore)
  embeddingGeneratorContext.provide(generateLocalEmbedding)
}

initializeApp().finally(() => {
  if (!LOCAL_RSS_MODE) {
    import("./push-notification").then(({ registerWebPushNotifications }) => {
      if (navigator.serviceWorker && WEB_BUILD) {
        registerWebPushNotifications()
      }
    })
  }

  // eslint-disable-next-line @eslint-react/dom/no-flush-sync
  flushSync(() => setAppIsReady(true))
})

const $container = document.querySelector("#root") as HTMLElement

if (IN_ELECTRON) {
  const os = getOS()

  switch (os) {
    case "Windows": {
      document.body.style.cssText += `--fo-window-padding-top: ${ElECTRON_CUSTOM_TITLEBAR_HEIGHT}px;`
      break
    }
    case "macOS": {
      document.body.style.cssText += `--fo-macos-traffic-light-width: 80px; --fo-macos-traffic-light-height: 30px;`
      break
    }
  }
  document.documentElement.dataset.os = getOS()
} else {
  registerAppGlobalShortcuts()
}

ReactDOM.createRoot($container).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
