import { Spring } from "@follow/components/constants/spring.js"
import { useMobile } from "@follow/components/hooks/useMobile.js"
import { PanelSplitter } from "@follow/components/ui/divider/index.js"
import { FeedViewType } from "@follow/constants"
import { defaultUISettings } from "@follow/shared/settings/defaults"
import { cn } from "@follow/utils"
import { isSafari } from "@follow/utils/utils"
import { AnimatePresence } from "motion/react"
import type { CSSProperties } from "react"
import { memo, useCallback, useEffect, useMemo, useRef } from "react"
import { useResizable } from "react-resizable-layout"

import { AIChatPanelStyle, useAIChatPanelStyle, useAIPanelVisibility } from "~/atoms/settings/ai"
import { getUISettings, setUISetting, useUISettingKey } from "~/atoms/settings/ui"
import { m } from "~/components/common/Motion"
import { ROUTE_ENTRY_PENDING } from "~/constants"
import { useNormalizeTimelineRoute } from "~/hooks/biz/useNormalizeTimelineRoute"
import { useRouteParamsSelector } from "~/hooks/biz/useRouteParams"
import { useShowEntryDetailsColumn } from "~/hooks/biz/useShowEntryDetailsColumn"
import { AIChatRoot } from "~/modules/ai-chat/components/layouts/AIChatRoot"
import { AIChatFixedPanel } from "~/modules/app-layout/ai/AIChatFixedPanel"
import { AIChatFloatingPanel } from "~/modules/app-layout/ai/AIChatFloatingPanel"
import { EntryContentPlaceholder } from "~/modules/app-layout/entry-content/EntryContentPlaceholder"
import { EntryColumn } from "~/modules/entry-column"
import { EntryContent } from "~/modules/entry-content/components/entry-content"
import { AIEntryHeader } from "~/modules/entry-content/components/entry-header"
import { AppLayoutGridContainerProvider } from "~/providers/app-grid-layout-container-provider"
import { MainViewHotkeysProvider } from "~/providers/main-view-hotkeys-provider"

import { resolveInitialEntryColumnWidth, resolveResetEntryColumnWidth } from "./entry-column-width"
import { MobileTimelineLayout } from "./MobileTimelineLayout"

const MIN_ENTRY_WIDTH = isSafari() ? 356 : 300

const AIEnhancedTimelineLayoutImpl = () => {
  useNormalizeTimelineRoute()

  const { view, entryId } = useRouteParamsSelector((state) => ({
    view: state.view,
    entryId: state.entryId,
  }))

  const realEntryId = entryId === ROUTE_ENTRY_PENDING ? "" : entryId
  const showEntryDetailsColumn = useShowEntryDetailsColumn()
  const aiPanelStyle = useAIChatPanelStyle()
  const isAIPanelVisible = useAIPanelVisibility()
  const hasSelectedEntry = Boolean(realEntryId)
  const isMobile = useMobile()

  // Compute derived values first
  const showEntryContentOnRight = showEntryDetailsColumn && hasSelectedEntry
  const isFixedPanelStyle = aiPanelStyle === AIChatPanelStyle.Fixed
  const shouldShowFixedAI = isFixedPanelStyle && isAIPanelVisible
  const showEntryContentOnLeft = !showEntryDetailsColumn && hasSelectedEntry
  const shouldRenderRightColumn = showEntryDetailsColumn || shouldShowFixedAI
  const shouldShowEntryBorder = showEntryDetailsColumn || shouldShowFixedAI

  // Mobile-specific logic: disable resizing and hide splitters
  const shouldDisableResize = isMobile
  const shouldShowSplitter = !isMobile && shouldRenderRightColumn

  const layoutContainerRef = useRef<HTMLDivElement>(null)
  const feedColumnWidth = useUISettingKey("feedColWidth")

  const timelineMaxWidth = useMemo(() => {
    if (typeof window === "undefined") return 600
    return Math.max((window.innerWidth - feedColumnWidth) / 2, 600)
  }, [feedColumnWidth])

  const entryColumnInitialWidth = useMemo(() => {
    if (typeof window === "undefined") return defaultUISettings.entryColWidth

    return resolveInitialEntryColumnWidth(
      getUISettings().entryColWidth,
      window.innerWidth,
      feedColumnWidth,
    )
  }, [feedColumnWidth])
  const timelineStartDragPosition = useRef(0)

  const {
    position: timelineColumnWidth,
    separatorProps: timelineSeparatorProps,
    isDragging: isTimelineDragging,
    separatorCursor: timelineSeparatorCursor,
    setPosition: setTimelineColumnWidth,
  } = useResizable({
    axis: "x",
    min: MIN_ENTRY_WIDTH,
    max: timelineMaxWidth,
    initial: entryColumnInitialWidth,
    containerRef: layoutContainerRef as React.RefObject<HTMLElement>,
    disabled: shouldDisableResize,
    onResizeStart({ position }) {
      timelineStartDragPosition.current = position
    },
    onResizeEnd({ position }) {
      if (position === timelineStartDragPosition.current) return
      setUISetting("entryColWidth", position)
      window.dispatchEvent(new Event("resize"))
    },
  })

  const isAllView = view === FeedViewType.All
  const widthRange: [number, number] = isAllView ? [500, timelineMaxWidth] : [300, timelineMaxWidth]
  const [minWidth, maxWidth] = widthRange

  const clampWidth = useCallback(
    (value: number) => Math.max(minWidth, Math.min(maxWidth, Math.round(value))),
    [minWidth, maxWidth],
  )

  const resolvePreferredWidth = useCallback(() => {
    const ui = getUISettings()
    const preferred = ui.aiColWidth ?? defaultUISettings.aiColWidth
    return clampWidth(preferred)
  }, [clampWidth])

  const aiPanelStartDragPosition = useRef(0)
  const {
    position: aiPanelWidth,
    separatorProps: aiSeparatorProps,
    isDragging: isAiPanelDragging,
    separatorCursor: aiSeparatorCursor,
    setPosition: setAiPanelWidth,
  } = useResizable({
    axis: "x",
    min: minWidth,
    max: maxWidth,
    initial: resolvePreferredWidth(),
    reverse: true,
    containerRef: layoutContainerRef as React.RefObject<HTMLElement>,
    disabled: shouldDisableResize,
    onResizeStart({ position }) {
      aiPanelStartDragPosition.current = position
    },
    onResizeEnd({ position }) {
      if (position === aiPanelStartDragPosition.current) return
      setUISetting("aiColWidth", position)
      window.dispatchEvent(new Event("resize"))
    },
  })

  useEffect(() => {
    const width = resolvePreferredWidth()
    setAiPanelWidth(width)
    window.dispatchEvent(new Event("resize"))
  }, [resolvePreferredWidth, setAiPanelWidth])

  const entryColumnStyle: CSSProperties = isMobile
    ? {
        width: "100%",
        minWidth: "100%",
        flexBasis: "100%",
      }
    : showEntryDetailsColumn
      ? {
          flexBasis: timelineColumnWidth,
          minWidth: MIN_ENTRY_WIDTH,
        }
      : {
          minWidth: MIN_ENTRY_WIDTH,
        }

  const rightColumnStyle: CSSProperties = isMobile
    ? {
        width: "100%",
        minWidth: "100%",
        flexBasis: "100%",
      }
    : showEntryDetailsColumn
      ? {
          minWidth: 0,
        }
      : {
          width: aiPanelWidth,
          minWidth: 0,
          flexBasis: aiPanelWidth,
        }

  const resetTimelineWidth = useCallback(() => {
    const resetWidth =
      typeof window === "undefined"
        ? defaultUISettings.entryColWidth
        : resolveResetEntryColumnWidth(window.innerWidth, feedColumnWidth)
    setUISetting("entryColWidth", defaultUISettings.entryColWidth)
    setTimelineColumnWidth(resetWidth)
    window.dispatchEvent(new Event("resize"))
  }, [feedColumnWidth, setTimelineColumnWidth])

  const resetAiWidth = useCallback(() => {
    const resetWidth = clampWidth(defaultUISettings.aiColWidth)
    setUISetting("aiColWidth", resetWidth)
    setAiPanelWidth(resetWidth)
    window.dispatchEvent(new Event("resize"))
  }, [clampWidth, setAiPanelWidth])

  const splitter = shouldShowSplitter ? (
    shouldRenderRightColumn && showEntryDetailsColumn ? (
      <PanelSplitter
        {...timelineSeparatorProps}
        cursor={timelineSeparatorCursor}
        isDragging={isTimelineDragging}
        onDoubleClick={resetTimelineWidth}
      />
    ) : shouldShowFixedAI ? (
      <PanelSplitter
        {...aiSeparatorProps}
        cursor={aiSeparatorCursor}
        isDragging={isAiPanelDragging}
        onDoubleClick={resetAiWidth}
      />
    ) : null
  ) : null

  // Mobile layout: stacked with view switching
  if (isMobile) {
    return <MobileTimelineLayout entryId={realEntryId} hasSelectedEntry={hasSelectedEntry} />
  }

  return (
    <div
      className={cn(
        "relative h-full min-w-0 grow",
        isAllView ? "flex flex-col overflow-y-auto scroll-smooth" : "flex",
      )}
    >
      <div
        className={cn(
          "relative h-full min-w-0",
          isAllView ? "min-h-full w-full flex-none" : "flex-1",
        )}
      >
        <AppLayoutGridContainerProvider>
          <div ref={layoutContainerRef} className="flex h-full min-w-0">
            <div
              data-hide-in-print={showEntryDetailsColumn ? true : undefined}
              className={cn(
                "relative flex h-full flex-col overflow-hidden",
                shouldShowEntryBorder && "border-r",
                showEntryDetailsColumn
                  ? "flex-none transition-[flex-basis] duration-200 ease-out will-change-[flex-basis]"
                  : "min-w-0 flex-1",
                showEntryDetailsColumn && isTimelineDragging && "transition-none",
              )}
              style={entryColumnStyle}
            >
              <EntryColumn />

              {/* Right-side drawer for entry content */}
              <AnimatePresence>
                {showEntryContentOnLeft && realEntryId && (
                  <m.div
                    key="entry-drawer"
                    initial={{ translateX: "100%", opacity: 0.8 }}
                    animate={{ translateX: 0, opacity: 1 }}
                    exit={{ translateX: "100%", opacity: 0.8 }}
                    transition={Spring.presets.snappy}
                    className="absolute inset-y-0 right-0 z-[12] flex w-[55%] min-w-[400px] max-w-[680px] flex-col overflow-hidden border-l shadow-xl backdrop-blur-2xl"
                    style={{
                      borderColor: "hsl(var(--fo-a) / 0.15)",
                      boxShadow:
                        "-8px 0 32px hsl(var(--fo-a) / 0.06), -4px 0 16px rgba(0,0,0,0.08)",
                      background:
                        "linear-gradient(to right, rgba(var(--color-background) / 0.97), rgba(var(--color-background) / 0.99))",
                    }}
                  >
                    <AIEntryHeader entryId={realEntryId} />
                    <div className="flex h-0 flex-1 flex-col overflow-hidden">
                      <EntryContent entryId={realEntryId} className="h-full" />
                    </div>
                  </m.div>
                )}
              </AnimatePresence>
            </div>

            {shouldRenderRightColumn && (
              <>
                {splitter}

                <div
                  data-hide-in-print={
                    !showEntryContentOnRight && shouldShowFixedAI ? true : undefined
                  }
                  className={cn(
                    "relative flex h-full min-w-0 flex-col overflow-hidden bg-theme-background",
                    showEntryDetailsColumn ? "flex-1 print:w-full" : "flex-none",
                  )}
                  style={rightColumnStyle}
                >
                  {showEntryContentOnRight && realEntryId ? (
                    <div className="flex h-full flex-col overflow-hidden">
                      <div className="absolute inset-x-0 top-0 z-10">
                        <AIEntryHeader entryId={realEntryId} />
                      </div>
                      <div className="flex h-0 flex-1 flex-col overflow-hidden">
                        <EntryContent entryId={realEntryId} className="h-full" />
                      </div>
                    </div>
                  ) : shouldShowFixedAI ? (
                    <div className="flex h-full flex-1 items-center justify-center">
                      <AIChatFixedPanel
                        key="ai-chat-layout"
                        style={
                          {
                            width: showEntryDetailsColumn ? "100%" : aiPanelWidth,
                            "--ai-chat-layout-width": showEntryDetailsColumn
                              ? "100%"
                              : `${aiPanelWidth}px`,
                          } as CSSProperties
                        }
                      />
                    </div>
                  ) : (
                    <div className="flex flex-1 items-center justify-center px-8">
                      <EntryContentPlaceholder />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </AppLayoutGridContainerProvider>
      </div>
      {!shouldShowFixedAI && <AIChatFloatingPanel />}
    </div>
  )
}

export const AIEnhancedTimelineLayout = memo(function AIEnhancedTimelineLayout() {
  return (
    <AIChatRoot wrapFocusable={false}>
      <AIEnhancedTimelineLayoutImpl />
      <MainViewHotkeysProvider />
    </AIChatRoot>
  )
})
AIEnhancedTimelineLayout.displayName = "AIEnhancedTimelineLayout"
