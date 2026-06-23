import type { SerializedEditorState } from "lexical"

export interface ChatSession {
  chatId: string
  title?: string
  createdAt: Date
  updatedAt: Date
  /** Last message timestamp; preferred for history list display */
  lastActivityAt?: Date
  isLocal: boolean
  syncStatus: "local" | "synced"
}

export type RichTextPart = {
  type: "data-rich-text"
  data: {
    state: SerializedEditorState
    text: string
  }
}
