import { useSummary } from "@follow/store/summary/hooks"

import { useActionLanguage } from "~/atoms/settings/general"

const normalizeSummaryText = (summary: string | null | undefined) => {
  if (!summary) return ""

  return summary
    .replaceAll(/```[\s\S]*?```/g, " ")
    .replaceAll(/`([^`]+)`/g, "$1")
    .replaceAll(/\*\*([^*]+)\*\*/g, "$1")
    .replaceAll(/\*([^*]+)\*/g, "$1")
    .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replaceAll(/^\s{0,3}#{1,6}\s+/gm, "")
    .replaceAll(/^\s*[-*+]\s+/gm, "")
    .replaceAll(/\s+/g, " ")
    .trim()
}

export const useEntrySummaryDescription = (entryId: string, fallback?: string | null) => {
  const actionLanguage = useActionLanguage()
  const summary = useSummary(entryId, actionLanguage)
  const summaryText = normalizeSummaryText(summary?.readabilitySummary || summary?.summary)

  return {
    description: summaryText || fallback || "",
    isSummary: !!summaryText,
  }
}
