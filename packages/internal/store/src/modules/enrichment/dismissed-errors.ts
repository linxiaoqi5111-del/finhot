import { getStorageNS } from "@follow/utils/ns"

import type { EnrichmentErrorCode } from "./error-utils"
import { buildEnrichmentErrorKey } from "./error-utils"

const DISMISSED_ERRORS_STORAGE_KEY = getStorageNS("enrichment_dismissed_errors")
const MAX_DISMISSED_ERRORS = 500

type DismissedErrorRecord = {
  key: string
  dismissedAt: string
}

type DismissedErrorsPayload = {
  version: "1.0"
  records: DismissedErrorRecord[]
}

const canUseLocalStorage = () => typeof localStorage !== "undefined"

const loadDismissedRecords = (): DismissedErrorRecord[] => {
  if (!canUseLocalStorage()) return []

  const raw = localStorage.getItem(DISMISSED_ERRORS_STORAGE_KEY)
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw) as Partial<DismissedErrorsPayload> | DismissedErrorRecord[]
    if (Array.isArray(parsed)) {
      return parsed.filter((record) => typeof record?.key === "string")
    }

    return (parsed.records ?? []).filter((record) => typeof record?.key === "string")
  } catch {
    return []
  }
}

const saveDismissedRecords = (records: DismissedErrorRecord[]) => {
  if (!canUseLocalStorage()) return

  const payload: DismissedErrorsPayload = {
    version: "1.0",
    records: records.slice(-MAX_DISMISSED_ERRORS),
  }
  localStorage.setItem(DISMISSED_ERRORS_STORAGE_KEY, JSON.stringify(payload))
}

export const isEnrichmentErrorDismissed = (errorKey: string) => {
  return loadDismissedRecords().some((record) => record.key === errorKey)
}

export const dismissEnrichmentError = (errorKey: string) => {
  const records = loadDismissedRecords().filter((record) => record.key !== errorKey)
  records.push({
    key: errorKey,
    dismissedAt: new Date().toISOString(),
  })
  saveDismissedRecords(records)
}

export const buildDismissedEnrichmentErrorKey = (entryId: string, errorCode: EnrichmentErrorCode) =>
  buildEnrichmentErrorKey(entryId, errorCode)
