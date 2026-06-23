import {
  dismissEnrichmentError,
  isEnrichmentErrorDismissed,
} from "@follow/store/enrichment/dismissed-errors"
import { useByokProcessingBusy, useEnrichmentStatus } from "@follow/store/enrichment/hooks"
import { entryEnrichmentService } from "@follow/store/enrichment/service"
import type { EnrichmentStatusSnapshot } from "@follow/store/enrichment/store"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { getActionLanguage, getGeneralSettings } from "~/atoms/settings/general"
import {
  getByokEntryTitle,
  useByokPhaseLabelText,
} from "~/modules/entry-enrichment/byok-processing-error-shared"
import { getByokPhases } from "~/modules/entry-enrichment/trigger"

const AUTO_HIDE_GRACE_MS = 10_000

const getErrorDescriptionKey = (error: NonNullable<EnrichmentStatusSnapshot["lastError"]>) => {
  if (error.errorCode === "enrichment_timeout") {
    return "byok_processing.error.timeout_description"
  }

  return "byok_processing.error.generic_description"
}

export const useByokProcessingErrorAlert = () => {
  const { t } = useTranslation("ai")
  const status = useEnrichmentStatus()
  const isBusy = useByokProcessingBusy()
  const getPhaseLabel = useByokPhaseLabelText()
  const { lastError } = status
  const [panelVisible, setPanelVisible] = useState(false)

  const isDismissed = lastError ? isEnrichmentErrorDismissed(lastError.errorKey) : false
  const visibleError = panelVisible && lastError && !isDismissed ? lastError : null

  useEffect(() => {
    if (!lastError || isEnrichmentErrorDismissed(lastError.errorKey)) {
      setPanelVisible(false)
      return
    }

    setPanelVisible(true)
  }, [lastError])

  useEffect(() => {
    if (!panelVisible || !lastError || isBusy) {
      return
    }

    const timer = window.setTimeout(() => {
      setPanelVisible(false)
    }, AUTO_HIDE_GRACE_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [isBusy, lastError, panelVisible])

  const dismissError = () => {
    if (!lastError) return

    dismissEnrichmentError(lastError.errorKey)
    setPanelVisible(false)
  }

  const retryErrorEntry = () => {
    if (!lastError) return

    const result = entryEnrichmentService.retryEntry({
      entryId: lastError.entryId,
      actionLanguage: getActionLanguage(),
      phases: getByokPhases(),
      translationMode: getGeneralSettings().translationMode,
    })

    if (!result.ok) {
      switch (result.reason) {
        case "missing_entry": {
          toast.error(t("byok_processing.error.retry_failed_missing"))
          break
        }
        case "unsubscribed": {
          toast.error(t("byok_processing.error.retry_failed_unsubscribed"))
          break
        }
        case "in_pipeline": {
          toast.message(t("byok_processing.error.retry_failed_in_pipeline"))
          break
        }
        case "nothing_to_do": {
          toast.message(t("byok_processing.error.retry_failed_nothing_to_do"))
          break
        }
      }
      return
    }

    setPanelVisible(false)
    toast.success(t("byok_processing.error.retry_started"))
  }

  return {
    visibleError,
    dismissError,
    retryErrorEntry,
    getPhaseLabel,
    getErrorDescription: (error: NonNullable<EnrichmentStatusSnapshot["lastError"]>) =>
      t(getErrorDescriptionKey(error)),
    formatRelativeErrorAt: (iso: string) => {
      const deltaMs = Date.now() - new Date(iso).getTime()
      if (deltaMs < 60_000) {
        return t("byok_processing.error.relative.just_now")
      }

      const minutes = Math.floor(deltaMs / 60_000)
      if (minutes < 60) {
        return t("byok_processing.error.relative.minutes", { count: minutes })
      }

      const hours = Math.floor(minutes / 60)
      return t("byok_processing.error.relative.hours", { count: hours })
    },
    getEntryTitle: getByokEntryTitle,
  }
}
