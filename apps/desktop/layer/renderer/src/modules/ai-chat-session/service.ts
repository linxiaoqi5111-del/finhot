import { AIPersistService } from "../ai-chat/services"
import { aiChatSessionStoreActions } from "./store"

class AIChatSessionServiceStatic {
  async loadSessionsFromDb() {
    const rows = await AIPersistService.getChatSessions()

    aiChatSessionStoreActions.setSessions(rows)
    return rows
  }

  async deleteSession(chatId: string) {
    await AIPersistService.deleteSession(chatId)
    aiChatSessionStoreActions.removeSession(chatId)
  }

  async syncSessionMessages(chatId: string) {
    try {
      return AIPersistService.loadUIMessages(chatId)
    } catch (error) {
      console.error("syncSessionMessages: failed", error)
      throw error
    }
  }
}

export const AIChatSessionService = new AIChatSessionServiceStatic()
