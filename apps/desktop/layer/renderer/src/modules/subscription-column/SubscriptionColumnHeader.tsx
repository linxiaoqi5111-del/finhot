import { ActionButton } from "@follow/components/ui/button/index.js"
import { RotatingRefreshIcon } from "@follow/components/ui/loading/index.jsx"
import { stopPropagation } from "@follow/utils/dom"
import { EventBus } from "@follow/utils/event-bus"
import { cn } from "@follow/utils/utils"
import { useAtomValue } from "jotai"
import { m } from "motion/react"
import type { FC, PropsWithChildren } from "react"
import { memo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useLocation, useNavigate } from "react-router"
import { toast } from "sonner"

import { setTimelineColumnShow, useSubscriptionColumnShow } from "~/atoms/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu/dropdown-menu"
import { useBackHome } from "~/hooks/biz/useNavigateEntry"
import { useRouteParamsSelector } from "~/hooks/biz/useRouteParams"
import { useI18n } from "~/hooks/common"
import { useContextMenu } from "~/hooks/common/useContextMenu"
import { copyToClipboard } from "~/lib/clipboard"
import { FocalLogo, FocalWordmark } from "~/modules/brand/FocalLogo"
import { timelineRefreshingAtom } from "~/modules/entry-column/atoms/timeline-refreshing"

export const SubscriptionColumnHeader = memo(() => {
  const timelineId = useRouteParamsSelector((s) => s.timelineId)
  const navigateBackHome = useBackHome(timelineId)
  const navigate = useNavigate()
  const location = useLocation()
  const normalStyle = !window.electron || window.electron.process.platform !== "darwin"
  const { t } = useTranslation()
  const isTimelineRefreshing = useAtomValue(timelineRefreshingAtom)
  return (
    <div
      className={cn(
        "mr-3 flex h-8 items-center",

        normalStyle
          ? "ml-4 justify-between"
          : "justify-between pl-[calc(var(--fo-macos-traffic-light-width,0px)+0.75rem)]",
      )}
    >
      {normalStyle ? (
        <LogoContextMenu>
          <div
            className="relative flex items-center gap-1 text-lg font-semibold"
            onClick={(e) => {
              e.stopPropagation()
              navigateBackHome()
            }}
          >
            <FocalLogo className="mr-1 size-6 rounded-md" />
            <FocalWordmark className="text-lg" />
          </div>
        </LogoContextMenu>
      ) : (
        <div onClick={stopPropagation}>
          <LayoutActionButton />
        </div>
      )}
      <div className="relative flex items-center gap-2" onClick={stopPropagation}>
        <ActionButton
          disabled={isTimelineRefreshing}
          tooltip={t("entry_list_header.refetch")}
          onClick={() => {
            EventBus.dispatch("timeline:refetch")
          }}
        >
          <RotatingRefreshIcon
            isRefreshing={isTimelineRefreshing}
            className={cn(
              "size-5 text-text-secondary",
              isTimelineRefreshing && "text-text-quaternary",
            )}
          />
        </ActionButton>

        <ActionButton
          data-testid="subscription-discover-trigger"
          shortcut="$mod+T"
          tooltip={t("words.discover")}
          onClick={() => {
            if (location.pathname !== "/discover") {
              navigate("/discover")
            }
          }}
        >
          <i className="i-focal-add size-5 text-text-secondary" />
        </ActionButton>

        {normalStyle && <LayoutActionButton />}
      </div>
    </div>
  )
})

const LayoutActionButton = ({ className }: { className?: string }) => {
  const feedColumnShow = useSubscriptionColumnShow()
  const t = useI18n()

  return (
    <m.div className="overflow-hidden">
      <ActionButton
        className={className}
        tooltip={t("sidebar.feed_column.toggle")}
        icon={
          <i
            className={cn(
              !feedColumnShow ? "i-focal-layout-leftbar-open" : "i-focal-layout-leftbar-close",
              "text-text-secondary",
            )}
          />
        }
        onClick={() => {
          setTimelineColumnShow(!feedColumnShow)
        }}
      />
    </m.div>
  )
}

const LogoContextMenu: FC<PropsWithChildren> = ({ children }) => {
  const [open, setOpen] = useState(false)
  const logoRef = useRef<HTMLImageElement>(null)
  const t = useI18n()
  const contextMenuProps = useContextMenu({
    onContextMenu: () => {
      setOpen(true)
    },
  })

  const logoTextRef = useRef<HTMLSpanElement>(null)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild {...contextMenuProps}>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          onClick={() => {
            copyToClipboard(logoRef.current?.outerHTML || "")
            setOpen(false)
            toast.success(t.common("app.copied_to_clipboard"))
          }}
        >
          <FocalLogo ref={logoRef} className="hidden" />
          <span>{t("app.copy_logo_svg")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            copyToClipboard(logoTextRef.current?.outerHTML || "")
            setOpen(false)
            toast.success(t.common("app.copied_to_clipboard"))
          }}
        >
          <FocalWordmark ref={logoTextRef} className="hidden" />
          <span>{t("app.copy_logo_text_svg")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
