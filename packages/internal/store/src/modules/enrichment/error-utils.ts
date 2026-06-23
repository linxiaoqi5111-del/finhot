export type EnrichmentErrorCode = "enrichment_timeout" | "enrichment_failed"

export const getEnrichmentErrorCode = (message: string): EnrichmentErrorCode => {
  if (message.includes("Timed out after")) {
    return "enrichment_timeout"
  }

  return "enrichment_failed"
}

export const buildEnrichmentErrorKey = (entryId: string, errorCode: EnrichmentErrorCode) =>
  `${entryId}:${errorCode}`
