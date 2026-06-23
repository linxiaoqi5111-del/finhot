import { useEffect, useState } from "react"
import { useEventCallback } from "usehooks-ts"

import { AIChatSessionService } from "~/modules/ai-chat-session/service"

import { AIPersistService } from "../services"
import { useChatActions } from "../store/hooks"
import type { BizUIMessage } from "../store/types"

const haveSameMessageSnapshot = (left: BizUIMessage[], right: BizUIMessage[]) => {
  if (left.length !== right.length) {
    return false
  }

  if (left.length === 0) {
    return true
  }

  return left.at(-1)?.id === right.at(-1)?.id
}

export const useLoadMessages = (
  chatId: string,
  options?: { onLoad?: (messages: BizUIMessage[]) => void },
) => {
  const chatActions = useChatActions()

  const [isLoading, setIsLoading] = useState(true)
  const [isSyncingRemote, setIsSyncingRemote] = useState(false)

  const onLoadEventCallback = useEventCallback((messages: BizUIMessage[]) => {
    options?.onLoad?.(messages)
  })

  useEffect(() => {
    if (!chatId) {
      setIsLoading(false)
      return
    }

    const currentMessages = chatActions.getMessages()
    const isCurrentChat = chatActions.getCurrentChatId() === chatId

    if (chatActions.get().isLocal) {
      // switchToChat already loaded messages for this chat; avoid redundant persist.
      if (isCurrentChat && currentMessages.length > 0) {
        setIsLoading(false)
        onLoadEventCallback(currentMessages)
        return
      }

      let mounted = true
      setIsLoading(true)

      AIPersistService.loadUIMessages(chatId)
        .then((messages) => {
          if (!mounted) {
            return
          }
          if (haveSameMessageSnapshot(currentMessages, messages)) {
            onLoadEventCallback(messages)
            return
          }
          chatActions.setMessages(messages)
          onLoadEventCallback(messages)
        })
        .catch((error) => {
          console.error(error)
        })
        .finally(() => {
          if (mounted) {
            setIsLoading(false)
          }
        })

      return () => {
        mounted = false
      }
    }
    let mounted = true
    setIsLoading(true)
    setIsSyncingRemote(false)
    AIChatSessionService.syncSessionMessages(chatId)
      .then(async (messages) => {
        if (!mounted) {
          return []
        }
        if (haveSameMessageSnapshot(currentMessages, messages)) {
          onLoadEventCallback(messages)
          return messages
        }
        chatActions.setMessages(messages)
        onLoadEventCallback(messages)
        return messages
      })
      .catch((error) => {
        console.error(error)
      })
      .finally(() => {
        if (mounted) {
          setIsLoading(false)
          setIsSyncingRemote(false)
        }
      })
    return () => {
      mounted = false
    }
  }, [chatId, onLoadEventCallback, chatActions])
  return { isLoading, isSyncingRemote }
}
