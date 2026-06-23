import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"

import { EntryContentPlaceholder } from "./EntryContentPlaceholder"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()

  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  }
})

const renderPlaceholder = async () => {
  const container = document.createElement("div")
  document.body.append(container)

  const root = createRoot(container)

  await act(async () => {
    root.render(<EntryContentPlaceholder />)
  })

  return { container, root }
}

describe("EntryContentPlaceholder", () => {
  let root: Root | null = null
  let container: HTMLElement | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }

    container?.remove()
    root = null
    container = null
  })

  test("uses the same empty-state text scale as the entry list", async () => {
    ;({ container, root } = await renderPlaceholder())

    const placeholder = container.firstElementChild

    expect(placeholder?.textContent).toBe("entry_content.no_selection")
    expect(placeholder?.classList.contains("text-base")).toBe(true)
    expect(placeholder?.classList.contains("text-zinc-400")).toBe(true)
    expect(placeholder?.classList.contains("text-sm")).toBe(false)
    expect(placeholder?.classList.contains("font-medium")).toBe(false)
    expect(placeholder?.classList.contains("text-text-tertiary")).toBe(false)
  })
})
