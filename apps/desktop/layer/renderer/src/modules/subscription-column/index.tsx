import { ActionButton } from "@follow/components/ui/button/index.js"
import { RootPortal } from "@follow/components/ui/portal/index.js"
import { FeedViewType } from "@follow/constants"
import { useTypeScriptHappyCallback } from "@follow/hooks"
import { ELECTRON_BUILD } from "@follow/shared/constants"
import { usePrefetchSubscription } from "@follow/store/subscription/hooks"
import { usePrefetchUnread } from "@follow/store/unread/hooks"
import { cn } from "@follow/utils/utils"
import type { PropsWithChildren } from "react"
import { useCallback, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"

import { useRootContainerElement } from "~/atoms/dom"
import { setTimelineColumnShow, useSubscriptionColumnShow } from "~/atoms/sidebar"
import { Focusable } from "~/components/common/Focusable"
import { HotkeyScope } from "~/constants"
import { useBackHome } from "~/hooks/biz/useNavigateEntry"

import { WindowUnderBlur } from "../../components/ui/background"
import { getSelectedFeedIds, resetSelectedFeedIds, setSelectedFeedIds } from "./atom"
import { useShouldFreeUpSpace } from "./hook"
import { SubscriptionListGuard } from "./subscription-list/SubscriptionListGuard"
import { SubscriptionColumnFooter } from "./SubscriptionColumnFooter"
import { SubscriptionColumnHeader } from "./SubscriptionColumnHeader"

export function SubscriptionColumn({
  children,
  className,
}: PropsWithChildren<{ className?: string }>) {
  const { t } = useTranslation()
  const { isLoading: isSubscriptionLoading } = usePrefetchSubscription()
  usePrefetchUnread()

  const shouldFreeUpSpace = useShouldFreeUpSpace()
  const feedColumnShow = useSubscriptionColumnShow()
  const rootContainerElement = useRootContainerElement()
  const navigateBackHome = useBackHome()

  const focusableContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!focusableContainerRef.current) return
    focusableContainerRef.current.focus()
  }, [])

  return (
    <WindowUnderBlur
      as={Focusable}
      scope={HotkeyScope.SubscriptionList}
      data-hide-in-print
      className={cn(
        "relative m-2 flex h-[calc(100%-1rem)] flex-col overflow-hidden rounded-2xl !bg-[rgb(247,247,247)] shadow-[0_12px_32px_-26px_rgba(0,0,0,0.42)] dark:!bg-sidebar dark:shadow-[0_18px_40px_-24px_rgba(0,0,0,0.85)]",
        !feedColumnShow && ELECTRON_BUILD && "bg-material-opaque",
        className,
      )}
      ref={focusableContainerRef}
      onClick={useCallback(async () => {
        if (document.hasFocus()) {
          navigateBackHome()
        }
      }, [navigateBackHome])}
    >
      <SubscriptionColumnHeader />
      {!feedColumnShow && (
        <RootPortal to={rootContainerElement}>
          <ActionButton
            tooltip={t("sidebar.feed_column.toggle")}
            className={cn(
              "center absolute top-2.5 z-10 hidden text-zinc-500 macos:flex",
              "macos:left-[calc(var(--fo-macos-traffic-light-width,0px)+0.75rem)]",
            )}
            onClick={(event) => {
              event.stopPropagation()
              setTimelineColumnShow(true)
            }}
          >
            <i className="i-focal-layout-leftbar-open" />
          </ActionButton>
        </RootPortal>
      )}

      <div
        className={cn("relative mt-3 flex min-h-0 flex-1", !shouldFreeUpSpace && "overflow-hidden")}
        onPointerDown={useTypeScriptHappyCallback((e) => {
          if (!(e.target instanceof HTMLElement) || !e.target.closest("[data-feed-id]")) {
            const nextSelectedFeedIds = getSelectedFeedIds()
            if (nextSelectedFeedIds.length === 0) {
              setSelectedFeedIds(nextSelectedFeedIds)
            } else {
              resetSelectedFeedIds()
            }
          }
        }, [])}
      >
        <section className="h-full w-feed-col shrink-0 snap-center">
          <SubscriptionListGuard
            view={FeedViewType.All}
            isSubscriptionLoading={isSubscriptionLoading}
          />
        </section>
      </div>

      <SubscriptionColumnFooter />

      {children}
    </WindowUnderBlur>
  )
}
