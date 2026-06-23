import { AIChatPanelStyle, setAIChatPanelStyle, setAIPanelVisibility } from "~/atoms/settings/ai"

export const openEntryAIChat = () => {
  setAIChatPanelStyle(AIChatPanelStyle.Floating)
  setAIPanelVisibility(true)
}
