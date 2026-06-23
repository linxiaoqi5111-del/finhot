import type { EnrichmentPhase } from "@follow/store/enrichment/types"
import { getEntry } from "@follow/store/entry/getter"
import { useTranslation } from "react-i18next"

export const getByokEntryTitle = (entryId: string) => {
  const entry = getEntry(entryId)
  return entry?.title?.trim() || entryId
}

export const useByokPhaseLabelText = () => {
  const { t } = useTranslation("ai")

  return (phase: EnrichmentPhase | null) => {
    switch (phase) {
      case "summary": {
        return t("byok_processing.phase.summary")
      }
      case "titleTranslation": {
        return t("byok_processing.phase.title_translation")
      }
      case "tags": {
        return t("byok_processing.phase.tags")
      }
      case "qualityScore": {
        return t("byok_processing.phase.quality_score")
      }
      default: {
        return t("byok_processing.phase.pending")
      }
    }
  }
}
