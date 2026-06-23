import { Spring } from "@follow/components/constants/spring.js"
import { cn, computeAdjustedTopLeftPosition } from "@follow/utils"
import { AnimatePresence, m } from "motion/react"
import type { ResizeDirection } from "re-resizable"
import { Resizable } from "re-resizable"
import type { FC, PointerEvent } from "react"
import { useCallback, useEffect, useRef } from "react"

import {
  clampFloatingPanelPosition,
  FLOATING_PANEL_MAX_WIDTH,
  FLOATING_PANEL_MIN_HEIGHT,
  FLOATING_PANEL_MIN_WIDTH,
  getFloatingPanelMaxHeight,
  getFloatingPanelState,
  setFloatingPanelState,
  useAIPanelVisibility,
  useFloatingPanelState,
} from "~/atoms/settings/ai"
import { Focusable } from "~/components/common/Focusable"
import { HotkeyScope } from "~/constants"
import { ChatHeader } from "~/modules/ai-chat/components/layouts/ChatHeader"
import { ChatInterface } from "~/modules/ai-chat/components/layouts/ChatInterface"

export interface AIChatFloatingPanelProps extends React.DetailedHTMLProps<
  React.HTMLAttributes<HTMLDivElement>,
  HTMLDivElement
> {}

const AIChatFloatingPanelInner: FC<AIChatFloatingPanelProps> = ({ className, ...props }) => {
  const floatingState = useFloatingPanelState()
  const panelRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<{
    pointerId: number
    startClientX: number
    startClientY: number
    startX: number
    startY: number
    offsetX: number
    offsetY: number
    frameId: number | null
  } | null>(null)

  // Preserve right/bottom margins to keep panel anchored to bottom-right on window resize
  const rightBottomMarginRef = useRef({ right: 0, bottom: 0 })
  useEffect(() => {
    rightBottomMarginRef.current = {
      right: Math.max(0, window.innerWidth - (floatingState.x + floatingState.width)),
      bottom: Math.max(0, window.innerHeight - (floatingState.y + floatingState.height)),
    }
  }, [floatingState.x, floatingState.y, floatingState.width, floatingState.height])

  const handleResize = useRef(
    (_event: MouseEvent | TouchEvent, direction: ResizeDirection, ref: HTMLElement) => {
      const prev = getFloatingPanelState()
      const newWidth = ref.offsetWidth
      const newHeight = ref.offsetHeight
      const { x, y } = computeAdjustedTopLeftPosition(
        { x: prev.x, y: prev.y, width: prev.width, height: prev.height },
        { width: newWidth, height: newHeight },
        direction,
      )
      const nextPosition = clampFloatingPanelPosition(x, y, newWidth, newHeight)

      setFloatingPanelState({ width: newWidth, height: newHeight, ...nextPosition })
    },
  ).current

  const clampPanelPosition = useCallback(
    (x: number, y: number) => {
      return clampFloatingPanelPosition(x, y, floatingState.width, floatingState.height)
    },
    [floatingState.height, floatingState.width],
  )

  const handleHeaderPointerDown = useCallback(
    (event: PointerEvent) => {
      const target = event.target as HTMLElement
      if (target.closest("button")) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragStateRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: floatingState.x,
        startY: floatingState.y,
        offsetX: 0,
        offsetY: 0,
        frameId: null,
      }
    },
    [floatingState.x, floatingState.y],
  )

  const handleHeaderPointerMove = useCallback((event: PointerEvent) => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) return

    dragState.offsetX = event.clientX - dragState.startClientX
    dragState.offsetY = event.clientY - dragState.startClientY

    if (dragState.frameId !== null) return

    dragState.frameId = window.requestAnimationFrame(() => {
      dragState.frameId = null
      panelRef.current?.style.setProperty(
        "transform",
        `translate3d(${dragState.offsetX}px, ${dragState.offsetY}px, 0)`,
      )
    })
  }, [])

  const handleHeaderPointerUp = useCallback(
    (event: PointerEvent) => {
      const dragState = dragStateRef.current
      if (!dragState || dragState.pointerId !== event.pointerId) return

      if (dragState.frameId !== null) {
        window.cancelAnimationFrame(dragState.frameId)
      }

      const nextPosition = clampPanelPosition(
        dragState.startX + dragState.offsetX,
        dragState.startY + dragState.offsetY,
      )
      dragStateRef.current = null
      const panelElement = panelRef.current
      if (panelElement) {
        panelElement.style.left = `${nextPosition.x}px`
        panelElement.style.top = `${nextPosition.y}px`
        panelElement.style.removeProperty("transform")
      }
      setFloatingPanelState(nextPosition)
    },
    [clampPanelPosition],
  )

  // Keep floating panel anchored to bottom-right on window resize
  useEffect(() => {
    const handleWindowResize = () => {
      const { right, bottom } = rightBottomMarginRef.current
      const newHeight = Math.min(floatingState.height, getFloatingPanelMaxHeight())
      const newX = window.innerWidth - floatingState.width - right
      const newY = window.innerHeight - newHeight - bottom
      setFloatingPanelState({
        height: newHeight,
        ...clampFloatingPanelPosition(newX, newY, floatingState.width, newHeight),
      })
    }

    window.addEventListener("resize", handleWindowResize)
    return () => window.removeEventListener("resize", handleWindowResize)
  }, [floatingState.width, floatingState.height])

  return (
    <m.div
      ref={panelRef}
      initial={{ scale: 0.92, y: 100, opacity: 0 }}
      animate={{ scale: 1, y: 0, opacity: 1 }}
      exit={{ scale: 0.92, y: 100, opacity: 0 }}
      transition={Spring.presets.smooth}
      className="fixed z-50"
      style={{
        left: floatingState.x,
        top: floatingState.y,
        // @ts-expect-error
        "--ai-chat-layout-width": `${floatingState.width}px`,
      }}
    >
      <div className="relative">
        <Resizable
          size={{ width: floatingState.width, height: floatingState.height }}
          onResize={handleResize}
          onResizeStop={handleResize}
          minWidth={FLOATING_PANEL_MIN_WIDTH}
          minHeight={FLOATING_PANEL_MIN_HEIGHT}
          maxWidth={FLOATING_PANEL_MAX_WIDTH}
          maxHeight={getFloatingPanelMaxHeight()}
          enable={{
            top: true,
            right: true,
            bottom: true,
            left: true,
            topRight: true,
            bottomRight: true,
            bottomLeft: true,
            topLeft: true,
          }}
        >
          <Focusable
            data-hide-in-print
            scope={HotkeyScope.AIChat}
            className={cn(
              "shadow-ai-chat-floating-panel relative flex h-full flex-col overflow-hidden rounded-lg border bg-background",
              className,
            )}
            {...props}
          >
            <ChatHeader
              isFloating
              onHeaderPointerDown={handleHeaderPointerDown}
              onHeaderPointerMove={handleHeaderPointerMove}
              onHeaderPointerUp={handleHeaderPointerUp}
            />
            <ChatInterface />
          </Focusable>
        </Resizable>
      </div>
    </m.div>
  )
}

export const AIChatFloatingPanel: FC<AIChatFloatingPanelProps> = (props) => {
  const visibility = useAIPanelVisibility()
  return (
    <AnimatePresence>
      {visibility && <AIChatFloatingPanelInner key="ai-chat-floating-panel" {...props} />}
    </AnimatePresence>
  )
}
