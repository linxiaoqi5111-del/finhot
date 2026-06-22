import type { DragEndEvent } from "@dnd-kit/core"
import { DndContext, PointerSensor, pointerWithin, useSensor, useSensors } from "@dnd-kit/core"
import { useGlobalFocusableScopeSelector } from "@follow/components/common/Focusable/hooks.js"
import { PanelSplitter } from "@follow/components/ui/divider/PanelSplitter.js"
import { Kbd } from "@follow/components/ui/kbd/Kbd.js"
import type { FeedViewType } from "@follow/constants"
import { defaultUISettings } from "@follow/shared/settings/defaults"
import { cn } from "@follow/utils"
import { Slot } from "@radix-ui/react-slot"
import { debounce } from "es-toolkit/compat"
import type { PropsWithChildren } from "react"
import * as React from "react"
import { useEffect, useRef, useState } from "react"
import { Trans } from "react-i18next"
import { useResizable } from "react-resizable-layout"

import { getUISettings, setUISetting } from "~/atoms/settings/ui"
import {
  getSubscriptionColumnTempShow,
  setSubscriptionColumnTempShow,
  useSubscriptionColumnShow,
  useSubscriptionColumnTempShow,
} from "~/atoms/sidebar"
import { FloatingLayerScope } from "~/constants"
import { SIDEBAR_CARD_INSET } from "~/constants/layout"
import { useBatchUpdateSubscription } from "~/hooks/biz/useSubscriptionActions"
import { useI18n } from "~/hooks/common"
import { AddBloggerButton } from "~/modules/add-blogger/AddBloggerButton"
import { COMMAND_ID } from "~/modules/command/commands/id"
import { useCommandBinding } from "~/modules/command/hooks/use-command-binding"
import { CornerPlayer } from "~/modules/player/corner-player"
import { SubscriptionColumn } from "~/modules/subscription-column"
import { removeEmptyFeedCategory, resetSelectedFeedIds } from "~/modules/subscription-column/atom"
import { UpdateNotice } from "~/modules/update-notice/UpdateNotice"
import { AppLayoutGridContainerProvider } from "~/providers/app-grid-layout-container-provider"

const FEED_COLUMN_MIN_WIDTH = 232
const FEED_COLUMN_MAX_WIDTH = 440
const clampFeedColumnWidth = (width: number) =>
  Math.max(FEED_COLUMN_MIN_WIDTH, Math.min(width, FEED_COLUMN_MAX_WIDTH))

export const SubscriptionColumnContainer = () => {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
  )

  const { mutate } = useBatchUpdateSubscription()
  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      if (!event.over) {
        return
      }

      const { category, view } = event.over.data.current as {
        category?: string | null
        view: FeedViewType
      }

      const activeData = event.active.data.current as
        | {
            feedIdList?: string[]
            view?: FeedViewType
          }
        | undefined
      const feedIdList = activeData?.feedIdList ?? []
      if (feedIdList.length === 0 || view === undefined || !category) {
        return
      }

      mutate({ category, view, feedIdList })
      removeEmptyFeedCategory(view, category)

      resetSelectedFeedIds()
    },
    [mutate],
  )

  return (
    <AppLayoutGridContainerProvider>
      <FeedResponsiveResizerContainer>
        <DndContext
          autoScroll={{ threshold: { x: 0, y: 0.2 } }}
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragEnd={handleDragEnd}
        >
          <SubscriptionColumn>
            <CornerPlayer />

            <UpdateNotice />

            <AddBloggerButton />
          </SubscriptionColumn>
        </DndContext>
      </FeedResponsiveResizerContainer>
    </AppLayoutGridContainerProvider>
  )
}

const FeedResponsiveResizerContainer = ({
  children,
}: {
  children: React.ReactNode
} & PropsWithChildren) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const { isDragging, position, separatorProps, separatorCursor, setPosition } = useResizable({
    axis: "x",
    min: FEED_COLUMN_MIN_WIDTH,
    max: FEED_COLUMN_MAX_WIDTH,
    initial: React.useMemo(() => clampFeedColumnWidth(getUISettings().feedColWidth), []),
    containerRef: containerRef as React.RefObject<HTMLElement>,

    onResizeEnd({ position }) {
      setUISetting("feedColWidth", position)
    },
  })

  const feedColumnShow = useSubscriptionColumnShow()
  const feedColumnTempShow = useSubscriptionColumnTempShow()
  const t = useI18n()

  useEffect(() => {
    if (feedColumnShow) {
      setSubscriptionColumnTempShow(false)
      return
    }
    const handler = debounce(
      (e: MouseEvent) => {
        const mouseX = e.clientX
        const mouseY = e.clientY

        const uiSettings = getUISettings()
        const feedColumnTempShow = getSubscriptionColumnTempShow()
        const isInEntryContentWideMode = false
        const feedWidth = clampFeedColumnWidth(uiSettings.feedColWidth)
        if (mouseY < 200 && isInEntryContentWideMode && mouseX < feedWidth) return
        const threshold = feedColumnTempShow ? feedWidth : 100

        if (mouseX < threshold) {
          setSubscriptionColumnTempShow(true)
        } else {
          setSubscriptionColumnTempShow(false)
        }
      },
      36,
      {
        leading: true,
      },
    )

    document.addEventListener("mousemove", handler)
    return () => {
      document.removeEventListener("mousemove", handler)
    }
  }, [feedColumnShow])

  const when = useGlobalFocusableScopeSelector(
    // eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-callback
    React.useCallback((activeScope) => !activeScope.or(...FloatingLayerScope), []),
  )

  useCommandBinding({
    commandId: COMMAND_ID.layout.toggleSubscriptionColumn,
    when,
  })

  const [delayShowSplitter, setDelayShowSplitter] = useState(feedColumnShow)
  useEffect(() => {
    let timer: any
    if (feedColumnShow) {
      timer = setTimeout(() => {
        setDelayShowSplitter(true)
      }, 200)
    } else {
      setDelayShowSplitter(false)
    }

    return () => {
      timer = clearTimeout(timer)
    }
  }, [feedColumnShow])

  return (
    <>
      <div
        data-hide-in-print
        className={cn(
          "shrink-0 overflow-hidden",
          "absolute inset-y-0 z-[2]",
          feedColumnTempShow && !feedColumnShow && "shadow-drawer-to-right z-[12]",
          !feedColumnShow && !feedColumnTempShow ? "-translate-x-full" : "",
          !isDragging ? "duration-200" : "",
        )}
        style={{
          width: `${position}px`,
          // @ts-expect-error
          "--fo-feed-col-w": `${Math.max(0, position - SIDEBAR_CARD_INSET * 2)}px`,
        }}
      >
        <Slot className={cn(!feedColumnShow ? "!bg-sidebar" : "")}>{children}</Slot>

        {delayShowSplitter && (
          <div className="absolute inset-y-2 right-2 z-[4] w-0" data-hide-in-print>
            <PanelSplitter
              isDragging={isDragging}
              cursor={separatorCursor}
              {...separatorProps}
              className="w-3 bg-transparent hover:bg-transparent active:!bg-transparent"
              onDoubleClick={() => {
                setUISetting("feedColWidth", defaultUISettings.feedColWidth)
                setPosition(defaultUISettings.feedColWidth)
              }}
              tooltip={
                !isDragging && (
                  <>
                    <div>
                      {/* <b>Drag</b> to resize */}
                      <Trans
                        t={t}
                        i18nKey="resize.tooltip.drag_to_resize"
                        components={{ b: <b /> }}
                      />
                    </div>
                    <div className="center">
                      <span>
                        <Trans
                          t={t}
                          i18nKey="resize.tooltip.double_click_to_collapse"
                          components={{ b: <b /> }}
                        />
                      </span>{" "}
                      <Kbd className="ml-1">{"["}</Kbd>
                    </div>
                  </>
                )
              }
            />
          </div>
        )}
      </div>

      <div
        data-hide-in-print
        className={!isDragging ? "duration-200" : ""}
        style={{
          width: feedColumnShow ? `${position}px` : `${SIDEBAR_CARD_INSET}px`,
        }}
      />
    </>
  )
}
