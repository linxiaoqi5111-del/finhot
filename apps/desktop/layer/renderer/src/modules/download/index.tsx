import { Button } from "@follow/components/ui/button/index.js"
import { APP_STORE_URLS } from "@follow/constants"
import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { getMobilePlatform, isMobileDevice } from "@follow/utils"
import { useEffect } from "react"

import { FOCAL_TAGLINE, FocalLogo, FocalWordmark } from "~/modules/brand/FocalLogo"

export function DownloadPage() {
  const openDownloadPage = () => {
    // Standalone builds do not use an official cloud download page.
  }

  const mobilePlatform = getMobilePlatform()
  const isMobile = isMobileDevice()

  useEffect(() => {
    if (LOCAL_RSS_MODE) {
      return
    }

    if (isMobile && mobilePlatform && APP_STORE_URLS[mobilePlatform]) {
      window.location.href = APP_STORE_URLS[mobilePlatform]
    }
  }, [isMobile, mobilePlatform])

  const handleMobileDownload = () => {
    if (LOCAL_RSS_MODE) return

    if (mobilePlatform && APP_STORE_URLS[mobilePlatform]) {
      window.location.href = APP_STORE_URLS[mobilePlatform]
    } else {
      openDownloadPage()
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6">
      {/* Logo Section */}
      <div className="mb-8 flex flex-col items-center text-center">
        <div className="mb-4 flex items-center space-x-4">
          <FocalLogo className="size-12 rounded-2xl" />
          <FocalWordmark className="text-2xl" />
        </div>
        <p className="text-base text-text-secondary">{FOCAL_TAGLINE}</p>
      </div>

      {/* Main Content */}
      <div className="w-full max-w-xs space-y-6 text-center">
        <div>
          <h1 className="mb-3 text-xl font-semibold text-text">
            {LOCAL_RSS_MODE ? "Local RSS desktop app" : "Download FinHot"}
          </h1>
          <p className="text-sm text-text-secondary">
            {LOCAL_RSS_MODE
              ? "This standalone build does not use official cloud download services."
              : isMobile
                ? mobilePlatform
                  ? `Get the ${mobilePlatform} app for the best experience`
                  : "Get the mobile app for the best experience"
                : "Get the mobile app for the best experience"}
          </p>
        </div>

        {/* Download Button */}
        <Button
          disabled={LOCAL_RSS_MODE}
          onClick={isMobile ? handleMobileDownload : openDownloadPage}
        >
          <i className="i-focal-download-2 mr-2 text-lg" />
          <span>
            {LOCAL_RSS_MODE
              ? "Download service disabled"
              : isMobile && mobilePlatform
                ? `Download for ${mobilePlatform}`
                : "Go to Download Page"}
          </span>
        </Button>

        {/* Hint */}
        <p className="text-xs text-text-tertiary">
          {isMobile
            ? mobilePlatform
              ? `Redirecting to ${mobilePlatform === "iOS" ? "App Store" : "Google Play"}...`
              : "Available for iOS, Android, Windows, macOS & Linux"
            : "Available for iOS, Android, Windows, macOS & Linux"}
        </p>
      </div>
    </div>
  )
}

export default DownloadPage
