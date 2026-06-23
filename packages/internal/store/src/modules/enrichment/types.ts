import type { SupportedActionLanguage } from "@follow/shared"
import type { GeneralSettings } from "@follow/shared/settings/interface"

export type EnrichmentPhase = "summary" | "titleTranslation" | "tags" | "qualityScore"

export type EnrichmentTranslationMode = GeneralSettings["translationMode"]

export const DEFAULT_ENRICHMENT_PHASES = ["summary"] as const satisfies readonly EnrichmentPhase[]

export type EnrichmentJob = {
  entryId: string
  actionLanguage: SupportedActionLanguage
  phases: readonly EnrichmentPhase[]
  translationMode: EnrichmentTranslationMode
}

export type EnrichmentEnqueueOptions = {
  entryIds: string[]
  actionLanguage: SupportedActionLanguage
  phases?: readonly EnrichmentPhase[]
  translationMode?: EnrichmentTranslationMode
  prepend?: boolean
}
