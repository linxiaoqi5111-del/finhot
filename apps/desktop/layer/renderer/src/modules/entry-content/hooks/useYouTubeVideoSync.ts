import { IN_ELECTRON } from "@follow/shared/constants"
import type { RefObject } from "react"
import { useCallback, useEffect, useRef, useState } from "react"

import type { YouTubeTranscriptCue } from "../components/layouts/shared/youtube-format"

const POLL_INTERVAL = 300

// Read the current playback position from the YouTube embed inside the webview.
// Prefer the player API, fall back to the raw <video> element so it keeps
// working even when the IFrame API is unavailable.
const READ_TIME_SCRIPT = `(() => {
  try {
    const player = document.getElementById('movie_player')
    if (player && typeof player.getCurrentTime === 'function') return player.getCurrentTime()
    const video = document.querySelector('video')
    return video ? video.currentTime : null
  } catch (_) {
    return null
  }
})()`

const buildSeekScript = (seconds: number) => `(() => {
  try {
    const player = document.getElementById('movie_player')
    if (player && typeof player.seekTo === 'function') {
      player.seekTo(${seconds}, true)
      if (typeof player.playVideo === 'function') player.playVideo()
      return true
    }
    const video = document.querySelector('video')
    if (video) {
      video.currentTime = ${seconds}
      if (typeof video.play === 'function') video.play()
      return true
    }
    return false
  } catch (_) {
    return false
  }
})()`

interface WebviewElement extends HTMLElement {
  executeJavaScript: (code: string) => Promise<unknown>
}

function isWebviewElement(el: HTMLElement | null): el is WebviewElement {
  return !!el && typeof (el as Partial<WebviewElement>).executeJavaScript === "function"
}

interface UseYouTubeVideoSyncOptions {
  playerRef: RefObject<HTMLElement | null>
  cues: YouTubeTranscriptCue[]
  enabled: boolean
}

/**
 * Syncs the YouTube transcript with the embedded player's playback position.
 *
 * The transcript is only available in the local desktop (Electron) build, where
 * the player is a `<webview>`. We poll the guest page via `executeJavaScript`
 * to read `currentTime` and resolve the active cue, and use the same channel to
 * seek when a cue is clicked. Outside Electron this is a no-op.
 */
export const useYouTubeVideoSync = ({ playerRef, cues, enabled }: UseYouTubeVideoSyncOptions) => {
  const [activeCueId, setActiveCueId] = useState<string | null>(null)

  // Keep the latest cues accessible inside the interval without resubscribing.
  const cuesRef = useRef(cues)
  cuesRef.current = cues

  useEffect(() => {
    if (!IN_ELECTRON || !enabled) {
      setActiveCueId(null)
      return
    }

    let cancelled = false
    let inFlight = false

    const resolveActiveCueId = (time: number): string | null => {
      const list = cuesRef.current
      if (list.length === 0) return null

      // Binary search for the last cue whose start time is at or before `time`.
      const target = time + 0.25
      let lo = 0
      let hi = list.length - 1
      let found = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (list[mid]!.seconds <= target) {
          found = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      return found >= 0 ? list[found]!.id : null
    }

    const tick = async () => {
      if (cancelled || inFlight) return
      const el = playerRef.current
      if (!isWebviewElement(el)) return

      inFlight = true
      try {
        const value = await el.executeJavaScript(READ_TIME_SCRIPT)
        if (cancelled) return
        if (typeof value === "number" && Number.isFinite(value)) {
          const next = resolveActiveCueId(value)
          setActiveCueId((prev) => (prev === next ? prev : next))
        }
      } catch {
        // The webview may not be ready yet (pre dom-ready) or navigating; ignore.
      } finally {
        inFlight = false
      }
    }

    const timer = setInterval(tick, POLL_INTERVAL)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [enabled, playerRef])

  const seekTo = useCallback(
    (seconds: number) => {
      const el = playerRef.current
      if (!isWebviewElement(el)) return
      void el.executeJavaScript(buildSeekScript(seconds)).catch(() => {})
    },
    [playerRef],
  )

  return { activeCueId, seekTo }
}
