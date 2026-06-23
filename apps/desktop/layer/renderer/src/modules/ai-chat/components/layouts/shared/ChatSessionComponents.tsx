import { cn } from "@follow/utils/utils"
import type { AIChatSession } from "@follow-app/client-sdk"
import dayjs from "dayjs"
import type { ReactNode } from "react"
import { useCallback } from "react"
import { useTranslation } from "react-i18next"

import type { ChatSession } from "~/modules/ai-chat/types/ChatSession"

import { getSessionDisplayDate, isUnreadSession } from "./utils"

// Types
export interface SessionItemProps {
  session: ChatSession | AIChatSession
  onClick?: () => void
  onDelete?: (e: React.MouseEvent) => void
  isLoading?: boolean
  hasUnread?: boolean
}

export interface EmptyStateProps {
  message: string
  icon?: ReactNode
}

const useSessionListDayFormatter = () => {
  const { t } = useTranslation("common")

  return useCallback(
    (date: Date) => {
      const now = new Date()
      const nowDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const inputDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())
      const diffDays = (nowDate.getTime() - inputDate.getTime()) / (1000 * 3600 * 24)

      if (diffDays === 0) {
        return t("time.today")
      }
      if (diffDays === 1) {
        return t("time.yesterday")
      }
      return dayjs(date).format("ll")
    },
    [t],
  )
}

export const SessionItem = ({
  session,
  onClick,
  onDelete,

  isLoading = false,
  hasUnread = false,
}: SessionItemProps) => {
  const { t } = useTranslation("ai")
  const formatSessionListDay = useSessionListDayFormatter()
  const hasUnreadMessages = isUnreadSession(session)
  const displayDate = formatSessionListDay(getSessionDisplayDate(session))

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => onClick?.()}
        className={cn(
          "w-full rounded-[5px] px-2.5 py-1.5 text-left outline-none",
          "hover:text-accent hover:bg-mix-background/accent-9/1",
          onClick ? "cursor-pointer" : "cursor-default",
        )}
      >
        <div className="ml-1 flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {hasUnreadMessages && (
              <span
                className="absolute left-2 block size-2 shrink-0 rounded-full bg-accent group-hover:bg-white"
                aria-label={t("chat.history.unread")}
                role="status"
              />
            )}
            <span className={cn("truncate font-medium", hasUnread ? "ml-2" : "")}>
              {session.title || t("chat.history.untitled")}
            </span>
          </div>
          <span className="ml-2 shrink-0 truncate text-xs text-text-secondary group-hover:text-accent">
            {displayDate}
          </span>
        </div>
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onDelete(event)
          }}
          disabled={isLoading}
          className={cn(
            "absolute inset-y-0 right-0 flex items-center rounded-md bg-accent px-2 py-1 text-white",
            "pointer-events-none opacity-0",
            "group-hover:pointer-events-auto group-hover:text-white group-hover:opacity-100",
            isLoading && "pointer-events-auto opacity-100",
          )}
          aria-label={t("chat.history.delete")}
        >
          {isLoading ? (
            <i className="i-focal-loading-3 size-4 animate-spin" />
          ) : (
            <i className="i-focal-delete-2 size-4" />
          )}
        </button>
      )}
    </div>
  )
}

export const EmptyState = ({ message, icon }: EmptyStateProps) => {
  return (
    <div className="flex flex-col items-center py-8 text-center">
      {icon || <i className="i-focal-time mb-2 block size-8 text-text-secondary" />}
      <p className="text-sm text-text-secondary">{message}</p>
    </div>
  )
}
