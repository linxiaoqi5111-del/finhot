import { cn } from "@follow/utils"
import { m } from "motion/react"

interface RateLimitNoticeProps {
  className?: string
  message?: string | null
}

/**
 * RateLimitNotice component
 * Displays rate limit information above the input in a subtle, non-alarming way
 */
export const RateLimitNotice = ({ className, message }: RateLimitNoticeProps) => {
  if (!message) {
    return
  }

  return (
    <m.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.2 }}
      className={cn("mb-3 block w-full text-left", className)}
    >
      <div className="flex items-center gap-2 rounded-lg border border-border bg-material-ultra-thick px-3 py-2 backdrop-blur-background">
        <i className="i-focal-information size-4 flex-shrink-0 text-text" />
        <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">{message}</span>
      </div>
    </m.div>
  )
}
