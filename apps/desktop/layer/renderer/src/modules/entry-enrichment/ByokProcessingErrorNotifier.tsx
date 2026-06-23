import { isEnrichmentErrorDismissed } from "@follow/store/enrichment/dismissed-errors"
import { useEnrichmentStatus } from "@follow/store/enrichment/hooks"
import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  getByokEntryTitle,
  useByokPhaseLabelText,
} from "~/modules/entry-enrichment/byok-processing-error-shared"

export const ByokProcessingErrorNotifier = () => {
  const { t } = useTranslation("ai")
  const { lastError } = useEnrichmentStatus()
  const getPhaseLabel = useByokPhaseLabelText()
  const lastToastedAtRef = useRef<string | null>(null)

  useEffect(() => {
    if (!lastError || isEnrichmentErrorDismissed(lastError.errorKey)) {
      return
    }

    if (lastToastedAtRef.current === lastError.at) {
      return
    }

    lastToastedAtRef.current = lastError.at
    const entryTitle = getByokEntryTitle(lastError.entryId)
    const phaseLabel = getPhaseLabel(lastError.phase)

    toast.error(t("byok_processing.error.toast_title"), {
      description: t("byok_processing.error.toast_description", {
        title: entryTitle,
        phase: phaseLabel,
      }),
      duration: 5000,
    })
  }, [getPhaseLabel, lastError, t])

  return null
}
