import { describe, expect, test } from "vitest"

import { createAuthRequestOriginHeaders } from "./headers"

describe("createAuthRequestOriginHeaders", () => {
  test("uses the web origin for auth requests", () => {
    expect(createAuthRequestOriginHeaders("http://127.0.0.1/login?from=desktop")).toEqual({
      Origin: "http://127.0.0.1",
      Referer: "http://127.0.0.1",
    })
  })

  test("returns empty headers for invalid urls", () => {
    expect(createAuthRequestOriginHeaders("not-a-url")).toEqual({})
  })
})
