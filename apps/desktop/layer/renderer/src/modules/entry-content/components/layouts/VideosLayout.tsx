import { useEntry } from "@follow/store/entry/hooks"
import { isYouTubeWatchUrl } from "@follow/utils/url-for-video"
import { useCallback, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { AIChatPanelStyle, useAIChatPanelStyle, useAIPanelVisibility } from "~/atoms/settings/ai"

import { useYouTubeTranscript } from "../../hooks/useYouTubeTranscript"
import { useYouTubeVideoSync } from "../../hooks/useYouTubeVideoSync"
import { AISummary } from "../AISummary"
import { EntryTitle } from "../EntryTitle"
import {
  ContentBody,
  MediaTranscript,
  TranscriptToggle,
  useTranscription,
  YouTubeContentBody,
  YouTubeTranscript,
} from "./shared"
import { VideoPlayer } from "./shared/VideoPlayer"
import { parseYouTubeTranscript } from "./shared/youtube-format"
import type { EntryLayoutProps } from "./types"

export const VideosLayout: React.FC<EntryLayoutProps> = ({
  entryId,
  compact = false,
  noMedia = false,
  translation,
}) => {
  const entry = useEntry(entryId, (state) => state)
  const { data: transcriptionData } = useTranscription(entryId)
  const {
    data: youtubeTranscript,
    isLoading: isYouTubeTranscriptLoading,
    isFetched: isYouTubeTranscriptFetched,
  } = useYouTubeTranscript(entryId, entry?.url)
  const [showTranscript, setShowTranscript] = useState(false)
  const { t } = useTranslation("app")

  const aiChatPanelStyle = useAIChatPanelStyle()
  const isAIPanelVisible = useAIPanelVisibility()
  const shouldShowAISummary = aiChatPanelStyle === AIChatPanelStyle.Floating || !isAIPanelVisible

  const playerRef = useRef<HTMLElement>(null)
  const youtubeCues = useMemo(
    () => (youtubeTranscript ? parseYouTubeTranscript(youtubeTranscript) : []),
    [youtubeTranscript],
  )
  const { activeCueId, seekTo } = useYouTubeVideoSync({
    playerRef,
    cues: youtubeCues,
    enabled: showTranscript && !transcriptionData && !!youtubeTranscript,
  })

  // Measure the pinned player height so auto-scrolled cues land below it
  // instead of being hidden behind the sticky player + floating header.
  const stickyObserverRef = useRef<ResizeObserver | null>(null)
  const [cueScrollMarginTop, setCueScrollMarginTop] = useState(0)
  const stickyPlayerRef = useCallback((node: HTMLDivElement | null) => {
    stickyObserverRef.current?.disconnect()
    if (!node) return
    const HEADER_OFFSET = 52 // h-top-header (3.25rem)
    const SAFE_GAP = 12
    const update = () => setCueScrollMarginTop(HEADER_OFFSET + node.offsetHeight + SAFE_GAP)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    stickyObserverRef.current = observer
  }, [])

  if (!entry) return null

  const isYouTubeEntry = isYouTubeWatchUrl(entry.url)
  const hasTranscript = !!transcriptionData || !!youtubeTranscript
  const showNoTranscriptMessage =
    isYouTubeEntry && isYouTubeTranscriptFetched && !isYouTubeTranscriptLoading && !hasTranscript
  const content = translation?.content || entry.content || entry.description

  return (
    <div className="mx-auto flex h-full flex-col p-6">
      {/* Offset the sticky top by the floating header height (h-top-header: 3.25rem)
          so the pinned player is never tucked under the absolute AIEntryHeader. */}
      <div
        ref={stickyPlayerRef}
        className="sticky top-[3.25rem] z-10 mb-4 w-full bg-background pb-2 pt-2"
      >
        {!noMedia ? (
          <VideoPlayer
            entryId={entryId}
            showDuration={true}
            preferFullSize={true}
            translation={translation}
            className="w-full"
            playerElementRef={playerRef}
          />
        ) : (
          <div className="center aspect-video w-full flex-col gap-1 rounded-md bg-material-medium text-sm text-text-secondary">
            <i className="i-focal-video-fill mb-2 size-12" />
            Video content not available
          </div>
        )}
      </div>

      <div className="flex-1 space-y-4">
        <EntryTitle entryId={entryId} compact={compact} />

        <TranscriptToggle
          showTranscript={showTranscript}
          onToggle={setShowTranscript}
          hasTranscript={hasTranscript || isYouTubeEntry}
        />

        {showTranscript ? (
          transcriptionData ? (
            <MediaTranscript
              className="prose !max-w-full dark:prose-invert"
              srt={transcriptionData}
              entryId={entryId}
              type="subtitle"
            />
          ) : youtubeTranscript ? (
            <YouTubeTranscript
              content={youtubeTranscript}
              activeCueId={activeCueId}
              onCueSeek={seekTo}
              cueScrollMarginTop={cueScrollMarginTop}
            />
          ) : isYouTubeTranscriptLoading ? (
            <div className="text-sm text-text-secondary">
              {t("entry_content.transcript_loading")}
            </div>
          ) : showNoTranscriptMessage ? (
            <div className="text-sm text-text-secondary">{t("entry_content.no_transcript")}</div>
          ) : null
        ) : (
          <>
            {shouldShowAISummary && <AISummary entryId={entryId} />}
            {isYouTubeEntry && content ? (
              <YouTubeContentBody content={content} className={compact ? "text-sm" : undefined} />
            ) : (
              <ContentBody
                entryId={entryId}
                translation={translation}
                compact={compact}
                noMedia={true}
                className="text-base"
              />
            )}
            {showNoTranscriptMessage && (
              <div className="text-sm text-text-tertiary">{t("entry_content.no_transcript")}</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
