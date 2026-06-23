import { cn } from "@follow/utils"
import { useEffect, useMemo, useRef } from "react"

import { Markdown } from "~/components/ui/markdown/Markdown"

import { parseYouTubeTranscript } from "./youtube-format"

// Suppress auto-scroll for a short window after the user scrolls manually, so
// the follow-along behavior never fights with the reader.
const MANUAL_SCROLL_SUPPRESS_MS = 2500

// Keep a few lines of already-played subtitles visible between the player and
// the active line, so the active (real-time) line sits just below the player
// in a stable teleprompter-like position instead of drifting to the bottom.
const PAST_CONTEXT_PX = 96

interface YouTubeTranscriptProps {
  className?: string
  content: string
  /** Id of the cue currently being played, used for highlight + auto-scroll. */
  activeCueId?: string | null
  /** When provided, cues become clickable and seek the player to their time. */
  onCueSeek?: (seconds: number) => void
  /**
   * Top offset (px) the active cue should keep clear when auto-scrolling, so it
   * never lands behind the sticky player + floating header.
   */
  cueScrollMarginTop?: number
}

export const YouTubeTranscript: React.FC<YouTubeTranscriptProps> = ({
  className,
  content,
  activeCueId,
  onCueSeek,
  cueScrollMarginTop = 0,
}) => {
  const cues = useMemo(() => parseYouTubeTranscript(content), [content])

  const activeCueRef = useRef<HTMLDivElement | null>(null)
  const lastManualScrollRef = useRef(0)

  useEffect(() => {
    const markManualScroll = () => {
      lastManualScrollRef.current = Date.now()
    }
    window.addEventListener("wheel", markManualScroll, { passive: true })
    window.addEventListener("touchmove", markManualScroll, { passive: true })
    return () => {
      window.removeEventListener("wheel", markManualScroll)
      window.removeEventListener("touchmove", markManualScroll)
    }
  }, [])

  useEffect(() => {
    if (!activeCueId) return
    const el = activeCueRef.current
    if (!el) return
    if (Date.now() - lastManualScrollRef.current < MANUAL_SCROLL_SUPPRESS_MS) return
    // `block: "start"` plus the cue's scroll-margin pins the active line just
    // below the player (with a few past lines as context), advancing one line
    // at a time like a teleprompter.
    el.scrollIntoView({ block: "start", behavior: "smooth" })
  }, [activeCueId])

  if (cues.length === 0) {
    return <Markdown className={cn("!max-w-full dark:prose-invert", className)}>{content}</Markdown>
  }

  const interactive = !!onCueSeek

  return (
    <div className={cn("flex flex-col", className)}>
      {cues.map((cue) => {
        const isActive = cue.id === activeCueId

        return (
          <div
            key={cue.id}
            ref={isActive ? activeCueRef : undefined}
            style={isActive ? { scrollMarginTop: cueScrollMarginTop + PAST_CONTEXT_PX } : undefined}
            role={interactive ? "button" : undefined}
            tabIndex={interactive ? 0 : undefined}
            onClick={interactive ? () => onCueSeek?.(cue.seconds) : undefined}
            onKeyDown={
              interactive
                ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      onCueSeek?.(cue.seconds)
                    }
                  }
                : undefined
            }
            className={cn(
              "group grid select-text grid-cols-[3.25rem_1fr] items-baseline gap-4 rounded-lg px-3 py-2 outline-none transition-colors duration-150",
              interactive && "cursor-pointer focus-visible:ring-2 focus-visible:ring-accent/40",
              isActive ? "bg-fill-secondary" : "hover:bg-fill-secondary/60",
            )}
          >
            <span
              className={cn(
                "select-none font-mono text-xs tabular-nums transition-colors",
                isActive ? "text-accent" : "text-text-tertiary group-hover:text-text-secondary",
              )}
            >
              {cue.time}
            </span>
            <p
              className={cn(
                "m-0 text-[0.95rem] leading-[1.75] transition-colors",
                isActive ? "text-text" : "text-text-secondary",
              )}
            >
              {cue.text}
            </p>
          </div>
        )
      })}
    </div>
  )
}
