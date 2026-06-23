import { describe, expect, test, vi } from "vitest"

import { AIChatPanelStyle, setAIChatPanelStyle, setAIPanelVisibility } from "~/atoms/settings/ai"

import { openEntryAIChat } from "./open-ai-chat"

vi.mock("~/atoms/settings/ai", () => ({
  AIChatPanelStyle: {
    Floating: "floating",
  },
  setAIChatPanelStyle: vi.fn(),
  setAIPanelVisibility: vi.fn(),
}))

describe("openEntryAIChat", () => {
  test("opens the AI chat as a floating panel for article context", () => {
    openEntryAIChat()

    expect(setAIChatPanelStyle).toHaveBeenCalledWith(AIChatPanelStyle.Floating)
    expect(setAIPanelVisibility).toHaveBeenCalledWith(true)
  })
})
