import { describe, expect, test } from "vitest"

import { buildEnrichmentErrorKey, getEnrichmentErrorCode } from "./error-utils"

describe("enrichment error utils", () => {
  test("maps timeout messages to enrichment_timeout", () => {
    expect(getEnrichmentErrorCode("[enrichment] Timed out after 90000ms: local-entry-1")).toBe(
      "enrichment_timeout",
    )
  })

  test("maps other messages to enrichment_failed", () => {
    expect(getEnrichmentErrorCode("Provider request failed")).toBe("enrichment_failed")
  })

  test("builds stable error keys", () => {
    expect(buildEnrichmentErrorKey("local-entry-1", "enrichment_timeout")).toBe(
      "local-entry-1:enrichment_timeout",
    )
  })
})
