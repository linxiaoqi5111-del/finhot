import { beforeEach, describe, expect, test, vi } from "vitest"

import { dismissEnrichmentError, isEnrichmentErrorDismissed } from "./dismissed-errors"

describe("dismissed enrichment errors", () => {
  beforeEach(() => {
    const storage = new Map<string, string>()
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value)
        },
        removeItem: (key: string) => {
          storage.delete(key)
        },
        clear: () => {
          storage.clear()
        },
      },
      configurable: true,
    })
    vi.clearAllMocks()
    localStorage.clear()
  })

  test("persists dismissed error keys", () => {
    const key = "local-entry-1:enrichment_timeout"

    expect(isEnrichmentErrorDismissed(key)).toBe(false)
    dismissEnrichmentError(key)
    expect(isEnrichmentErrorDismissed(key)).toBe(true)
  })
})
