import { useCallback } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { useDialog } from "~/components/ui/modal/stacked/hooks"
import { useTimelineSummaryAutoContext } from "~/modules/ai-chat/hooks/useTimelineSummaryAutoContext"
import { useBlockActions, useChatActions, useCurrentChatId } from "~/modules/ai-chat/store/hooks"
import type { ChatSession } from "~/modules/ai-chat/types/ChatSession"
import { AIChatSessionService } from "~/modules/ai-chat-session/service"

export interface UseChatSessionHandlersProps {
  sessions?: ChatSession[]
  onSessionSelected?: () => void
}

export const useChatSessionHandlers = ({
  sessions = [],
  onSessionSelected,
}: UseChatSessionHandlersProps) => {
  const { t } = useTranslation("ai")
  const chatActions = useChatActions()
  const blockActions = useBlockActions()
  const currentChatId = useCurrentChatId()
  const shouldDisableTimelineSummary = useTimelineSummaryAutoContext()
  const { ask } = useDialog()

  const handleSessionSelect = useCallback(
    async (chatId: string) => {
      onSessionSelected?.()

      const activeChatId = chatActions.getCurrentChatId()
      if (chatId === activeChatId) {
        return
      }

      if (shouldDisableTimelineSummary) {
        chatActions.setTimelineSummaryManualOverride(true)
      }

      try {
        blockActions.clearBlocks({ keepSpecialTypes: true })
        await chatActions.switchToChat(chatId)
      } catch (error) {
        console.error("Failed to switch to chat:", error)
        toast.error(t("chat.history.switch_error"))
      }
    },
    [blockActions, chatActions, onSessionSelected, shouldDisableTimelineSummary, t],
  )

  const handleDeleteSession = useCallback(
    async (
      chatId: string,
      options: {
        event?: React.MouseEvent
        onBeforeDelete?: () => void
      } = {},
    ) => {
      options.event?.stopPropagation()
      options.event?.preventDefault()

      const session = sessions?.find((s) => s.chatId === chatId)
      if (!session) return

      const confirm = await ask({
        title: t("delete_chat"),
        message: t("delete_chat_message", {
          title: session.title || t("chat.history.untitled"),
        }),
        variant: "danger",
      })

      if (!confirm) return
      options.onBeforeDelete?.()

      try {
        await AIChatSessionService.deleteSession(chatId)

        toast.success(t("delete_chat_success"))

        if (chatId === currentChatId) {
          if (shouldDisableTimelineSummary) {
            chatActions.setTimelineSummaryManualOverride(true)
          }
          blockActions.clearBlocks({ keepSpecialTypes: true })
          await chatActions.newChat()
        }
      } catch (error) {
        console.error("Failed to delete session:", error)
        toast.error(t("delete_chat_error"))
      }
    },
    [sessions, ask, t, currentChatId, chatActions, blockActions, shouldDisableTimelineSummary],
  )

  return {
    handleSessionSelect,
    handleDeleteSession,
  }
}
