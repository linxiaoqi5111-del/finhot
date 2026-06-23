import { getView } from "@follow/constants"
import { LOCAL_RSS_MODE } from "@follow/shared/constants"

import { AIChatPanelStyle, useAIChatPanelStyle, useAIPanelVisibility } from "~/atoms/settings/ai"
import { useRouteParamsSelector } from "~/hooks/biz/useRouteParams"

export const useShowEntryDetailsColumn = () => {
  const { view } = useRouteParamsSelector((s) => ({
    view: s.view,
  }))
  const aiPanelStyle = useAIChatPanelStyle()
  const isAIPanelVisible = useAIPanelVisibility()

  // FinHot: never show fixed right column — use drawer overlay instead
  if (LOCAL_RSS_MODE) return false

  return (
    !getView(view).wideMode && (aiPanelStyle === AIChatPanelStyle.Floating || !isAIPanelVisible)
  )
}
