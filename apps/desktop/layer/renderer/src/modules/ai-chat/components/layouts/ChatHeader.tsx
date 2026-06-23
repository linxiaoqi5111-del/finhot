import { ActionButton } from "@follow/components/ui/button/index.js"
import { cn } from "@follow/utils"
import { useAtomValue } from "jotai"
import type { FC, PointerEvent, ReactNode } from "react"
import { useCallback } from "react"
import { useTranslation } from "react-i18next"

import {
  AIChatPanelStyle,
  setAIChatPanelStyle,
  setAIPanelVisibility,
  useAIChatPanelStyle,
} from "~/atoms/settings/ai"
import { useTimelineSummaryAutoContext } from "~/modules/ai-chat/hooks/useTimelineSummaryAutoContext"
import {
  useBlockActions,
  useChatActions,
  useCurrentTitle,
  useHasMessages,
} from "~/modules/ai-chat/store/hooks"

import { useAIRootState } from "../../store/AIChatContext"
import { AISpline } from "../3d-models/AISpline"
import { ChatHistoryDropdown } from "./ChatHistoryDropdown"
import { AIHeaderTitle } from "./ChatTitle"

// Base header layout with shared logic inside
const ChatHeaderLayout = ({
  renderActions,
  isFloating,
  onHeaderPointerDown,
  onHeaderPointerMove,
  onHeaderPointerUp,
}: {
  renderActions: (ctx: {
    onNewChatClick: () => void
    currentTitle: string | undefined
    displayTitle: string | undefined
    panelStyle: AIChatPanelStyle
    onTogglePanelStyle: () => void
  }) => ReactNode
  isFloating: boolean
  onHeaderPointerDown?: (event: PointerEvent) => void
  onHeaderPointerMove?: (event: PointerEvent) => void
  onHeaderPointerUp?: (event: PointerEvent) => void
}) => {
  const hasMessages = useHasMessages()
  const currentTitle = useCurrentTitle()
  const chatActions = useChatActions()
  const blockActions = useBlockActions()
  const { t } = useTranslation("ai")
  const shouldDisableTimelineSummary = useTimelineSummaryAutoContext()
  const panelStyle = useAIChatPanelStyle()

  const displayTitle = currentTitle

  const handleNewChatClick = useCallback(() => {
    const messages = chatActions.getMessages()

    if (messages.length === 0) {
      return
    }

    if (shouldDisableTimelineSummary) {
      chatActions.setTimelineSummaryManualOverride(true)
    }

    chatActions.newChat()
    blockActions.clearBlocks({ keepSpecialTypes: true })
  }, [chatActions, blockActions, shouldDisableTimelineSummary])

  const handleTogglePanelStyle = useCallback(() => {
    const newStyle =
      panelStyle === AIChatPanelStyle.Fixed ? AIChatPanelStyle.Floating : AIChatPanelStyle.Fixed
    setAIChatPanelStyle(newStyle)
  }, [panelStyle])

  const { isScrolledBeyondThreshold } = useAIRootState()
  const isScrolledBeyondThresholdValue = useAtomValue(isScrolledBeyondThreshold)
  return (
    <div
      onPointerDown={onHeaderPointerDown}
      onPointerMove={onHeaderPointerMove}
      onPointerUp={onHeaderPointerUp}
      onPointerCancel={onHeaderPointerUp}
      className={cn(
        "absolute inset-x-0 top-0 z-[1] border-b border-transparent duration-200",
        isFloating && "cursor-move",
        !isFloating && "bg-background data-[scrolled-beyond-threshold=true]:border-b-border",
      )}
      data-scrolled-beyond-threshold={isScrolledBeyondThresholdValue}
    >
      <div className="h-top-header">
        {isFloating && (
          <div
            className="absolute inset-0 bg-background/70 backdrop-blur-background"
            style={{
              maskImage: `linear-gradient(to bottom, black 0%, black 90%, transparent 100%)`,
            }}
          />
        )}

        <div
          className={cn(
            "relative z-10 flex h-full items-center justify-between px-4 duration-200",
            "macos-left-column-hidden:pl-[calc(var(--fo-macos-traffic-light-width,0px)+3.75rem)]",
          )}
        >
          <div className="mr-2 flex min-w-0 items-center">
            {(hasMessages || currentTitle) && (
              <div>
                <AISpline className="no-drag-region -mx-0.5 -mb-0.5 mr-1 size-7" />
              </div>
            )}
            <ChatHistoryDropdown
              triggerElement={
                <AIHeaderTitle title={displayTitle} placeholder={t("common.new_chat")} />
              }
            />
          </div>

          {/* Right side - Actions */}
          <div className="flex items-center gap-2">
            {renderActions({
              onNewChatClick: handleNewChatClick,
              currentTitle,
              displayTitle,
              panelStyle,
              onTogglePanelStyle: handleTogglePanelStyle,
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

export const ChatHeader: FC<{
  isFloating: boolean
  onHeaderPointerDown?: (event: PointerEvent) => void
  onHeaderPointerMove?: (event: PointerEvent) => void
  onHeaderPointerUp?: (event: PointerEvent) => void
}> = ({ isFloating, onHeaderPointerDown, onHeaderPointerMove, onHeaderPointerUp }) => {
  const { t } = useTranslation("ai")

  return (
    <ChatHeaderLayout
      isFloating={isFloating}
      onHeaderPointerDown={onHeaderPointerDown}
      onHeaderPointerMove={onHeaderPointerMove}
      onHeaderPointerUp={onHeaderPointerUp}
      renderActions={({ onNewChatClick, panelStyle, onTogglePanelStyle }) => (
        <>
          <ActionButton tooltip={t("common.new_chat")} onClick={onNewChatClick}>
            <i className="i-focal-edit size-5 text-text-secondary" />
          </ActionButton>
          <ActionButton
            tooltip={
              panelStyle === AIChatPanelStyle.Fixed
                ? t("common.switch_to_floating_panel")
                : t("common.switch_to_fixed_panel")
            }
            onClick={onTogglePanelStyle}
          >
            <i
              className={`size-5 text-text-secondary ${
                panelStyle === AIChatPanelStyle.Fixed
                  ? "i-focal-rectangle-vertical"
                  : "i-focal-layout-right"
              }`}
            />
          </ActionButton>

          {isFloating && (
            <>
              <div className="h-5 w-px bg-border" />
              <ActionButton tooltip={t("common.close")} onClick={() => setAIPanelVisibility(false)}>
                <i className="i-focal-close size-5 text-text-secondary" />
              </ActionButton>
            </>
          )}
        </>
      )}
    />
  )
}

export const ChatPageHeader = () => {
  const { t } = useTranslation("ai")

  return (
    <ChatHeaderLayout
      isFloating={false}
      renderActions={({ onNewChatClick, panelStyle, onTogglePanelStyle }) => (
        <>
          <ActionButton tooltip={t("common.new_chat")} onClick={onNewChatClick}>
            <i className="i-focal-edit size-5 text-text-secondary" />
          </ActionButton>
          <ActionButton
            tooltip={
              panelStyle === AIChatPanelStyle.Fixed
                ? t("common.switch_to_floating_panel")
                : t("common.switch_to_fixed_panel")
            }
            onClick={onTogglePanelStyle}
          >
            <i
              className={`size-5 text-text-secondary ${
                panelStyle === AIChatPanelStyle.Fixed
                  ? "i-focal-rectangle-vertical"
                  : "i-focal-layout-right"
              }`}
            />
          </ActionButton>
        </>
      )}
    />
  )
}
