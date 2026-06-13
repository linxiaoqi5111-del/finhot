import { useChatStore } from "@/stores/chat-store"
import type { IngestStreamHooks } from "@/lib/ingest"

/**
 * 构造一组流式 hooks，把 autoIngest 的每个 stage 推送到当前 chat conversation。
 * 每个 stage 表现为一条独立的 assistant 消息。
 *
 * @param filePrefix 批量场景前缀（如 `[file1.pdf]`），单文件场景留空
 */
export function makeChatStreamHooks(filePrefix?: string): IngestStreamHooks {
  let stageAccumulator = ""

  return {
    onStageStart: (_stage, label) => {
      const chat = useChatStore.getState()
      const header = filePrefix ? `**${filePrefix} ${label}**\n\n` : `**${label}**\n\n`
      stageAccumulator = header
      chat.setStreaming(true)
      chat.appendStreamToken(header)
    },
    onStageToken: (token) => {
      stageAccumulator += token
      useChatStore.getState().appendStreamToken(token)
    },
    onStageEnd: () => {
      useChatStore.getState().finalizeStream(stageAccumulator)
      stageAccumulator = ""
    },
  }
}
