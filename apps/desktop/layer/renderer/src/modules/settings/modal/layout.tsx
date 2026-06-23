import { Spring } from "@follow/components/constants/spring.js"
import { LetsIconsResizeDownRightLight } from "@follow/components/icons/resize.jsx"
import { IN_ELECTRON, LOCAL_RSS_MODE } from "@follow/shared/constants"
import { useIsLoggedIn } from "@follow/store/user/hooks"
import { preventDefault } from "@follow/utils/dom"
import { cn, getOS } from "@follow/utils/utils"
import { atom, useAtomValue, useSetAtom } from "jotai"
import type { BoundingBox } from "motion/react"
import { Resizable } from "re-resizable"
import type { PropsWithChildren } from "react"
import { memo, Suspense, use, useCallback, useMemo, useRef } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"

import { useUISettingSelector } from "~/atoms/settings/ui"
import { m } from "~/components/common/Motion"
import { resizableOnly } from "~/components/ui/modal"
import { useModalResizeAndDrag } from "~/components/ui/modal/stacked/internal/use-drag"
import { ElECTRON_CUSTOM_TITLEBAR_HEIGHT } from "~/constants"
import { useRequireLogin } from "~/hooks/common/useRequireLogin"

import { isGuestAccessibleSettingTab, SETTING_MODAL_ID } from "../constants"
import { EnhancedSettingsIndicator } from "../helper/EnhancedIndicator"
import { useAvailableSettings, useSettingPageContext } from "../hooks/use-setting-ctx"
import { SettingsSidebarTitle } from "../title"
import type { SettingPageConfig } from "../utils"
import { DisableWhy } from "../utils"
import { SettingModalContentPortalableContext, useSetSettingTab, useSettingTab } from "./context"
import { defaultCtx, SettingContext } from "./hooks"

export function SettingModalLayout(props: PropsWithChildren) {
  const { children } = props
  const { t } = useTranslation("settings")

  const elementRef = useRef<HTMLDivElement>(null)
  const edgeElementRef = useRef<HTMLDivElement>(null)
  const {
    handleDrag,
    handleResizeStart,
    handleResizeStop,
    preferDragDir,
    isResizeable,
    resizeableStyle,

    dragController,
  } = useModalResizeAndDrag(elementRef, {
    resizeable: true,
    draggable: true,
  })

  const { draggable, overlay } = useUISettingSelector((state) => ({
    draggable: state.modalDraggable,
    overlay: state.modalOverlay,
  }))

  const measureDragConstraints = useRef((constraints: BoundingBox) => {
    if (getOS() === "Windows") {
      return {
        ...constraints,
        top: constraints.top + ElECTRON_CUSTOM_TITLEBAR_HEIGHT,
      }
    }
    return constraints
  }).current

  const portalableCtxValue = useMemo(() => {
    return atom(null as any)
  }, [])

  return (
    <div
      id={SETTING_MODAL_ID}
      className={cn("h-full", !isResizeable && "center")}
      ref={edgeElementRef}
    >
      <m.div
        exit={{
          opacity: 0,
          scale: 0.96,
        }}
        transition={Spring.presets.smooth}
        className={cn(
          "relative flex overflow-hidden rounded-2xl border border-border/70 bg-background",
          !overlay &&
            "shadow-[0_24px_80px_rgba(0,0,0,0.14)] dark:shadow-[0_24px_90px_rgba(0,0,0,0.42)]",
        )}
        style={resizeableStyle}
        onContextMenu={preventDefault}
        drag={draggable && (preferDragDir || draggable)}
        dragControls={dragController}
        dragListener={false}
        dragMomentum={false}
        dragElastic={false}
        dragConstraints={edgeElementRef}
        onMeasureDragConstraints={measureDragConstraints}
        whileDrag={{
          cursor: "grabbing",
        }}
      >
        {/* eslint-disable-next-line @eslint-react/no-context-provider */}
        <SettingContext.Provider value={defaultCtx}>
          <Resizable
            onResizeStart={handleResizeStart}
            onResizeStop={handleResizeStop}
            enable={resizableOnly("bottomRight")}
            defaultSize={{
              width: 920,
              height: 760,
            }}
            maxHeight="92vh"
            minHeight={400}
            minWidth={700}
            maxWidth="95vw"
            className="flex !select-none flex-col"
          >
            {draggable && (
              <div className="absolute inset-x-0 top-0 z-[1] h-8" onPointerDown={handleDrag} />
            )}
            <div className="flex h-0 flex-1" ref={elementRef}>
              <div className="flex min-h-0 w-52 shrink-0 flex-col rounded-l-2xl border-r border-r-border/70 bg-sidebar/95 px-3.5 py-6 backdrop-blur-background">
                <div className="mb-5 px-2 text-xl font-bold tracking-normal text-text">
                  {t("actions.action_card.settings")}
                </div>
                <nav className="flex min-h-0 grow flex-col gap-0.5 overflow-y-auto pb-2">
                  <SidebarItems />
                </nav>

                {!LOCAL_RSS_MODE && (
                  <div className="relative -mb-5 mt-2 flex h-7 shrink-0 items-center justify-end gap-2">
                    <EnhancedSettingsIndicator />
                  </div>
                )}
              </div>
              <div className="relative flex h-full min-w-0 flex-1 flex-col bg-background">
                <SettingModalContentPortalableContext value={portalableCtxValue}>
                  <Suspense>{children}</Suspense>
                  <SettingModalContentPortalable />
                </SettingModalContentPortalableContext>
              </div>
            </div>

            <LetsIconsResizeDownRightLight className="pointer-events-none absolute bottom-0 right-0 size-6 translate-x-px translate-y-px text-border/70" />
          </Resizable>
        </SettingContext.Provider>
      </m.div>
    </div>
  )
}

const SettingModalContentPortalable = () => {
  const setElement = useSetAtom(use(SettingModalContentPortalableContext))
  return <div ref={setElement as any} />
}

const SettingItemButtonImpl = (props: {
  setTab: (tab: string) => void
  item: SettingPageConfig
  path: string
  isActive: boolean
  onChange?: (tab: string) => void
  guestLocked?: boolean
}) => {
  const { setTab, item, path, onChange, isActive, guestLocked = false } = props
  const { disableIf } = item

  const ctx = useSettingPageContext()
  const { ensureLogin } = useRequireLogin()

  const [disabledByConfig, whyFromConfig = DisableWhy.Noop] = disableIf?.(ctx) || [
    false,
    DisableWhy.Noop,
  ]
  const disabled = guestLocked || disabledByConfig
  const why = disabledByConfig ? whyFromConfig : DisableWhy.Noop

  return (
    <button
      data-testid={`settings-tab-${path}`}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "group/settings-tab flex w-full items-center rounded-lg px-3 py-2 text-text-secondary transition-[background-color,color,box-shadow] duration-150",
        isActive && "!bg-fill-secondary !text-text shadow-[0_1px_0_rgba(0,0,0,0.03)]",
        !IN_ELECTRON && "hover:bg-fill-quaternary hover:text-text",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray/30",
        disabled && "opacity-50",
        disabledByConfig && "cursor-not-allowed",
      )}
      type="button"
      onClick={useCallback(() => {
        if (guestLocked) {
          ensureLogin()
          return
        }
        if (disabled) {
          switch (why) {
            case DisableWhy.NotActivation: {
              return
            }
            case DisableWhy.Noop: {
              break
            }
          }
        }
        setTab(path)
        onChange?.(path)
      }, [disabled, ensureLogin, guestLocked, onChange, path, setTab, why])}
    >
      <SettingsSidebarTitle path={path} active={isActive} />
    </button>
  )
}

const SettingItemButton = memo(SettingItemButtonImpl)

export const SidebarItems = memo((props: { onChange?: (tab: string) => void }) => {
  const { onChange } = props
  const setTab = useSetSettingTab()
  const tab = useSettingTab()
  const availableSettings = useAvailableSettings()
  const isLoggedIn = useIsLoggedIn()

  return availableSettings.map((setting) => {
    const isActive = tab === setting.path
    const guestLocked = !isLoggedIn && !isGuestAccessibleSettingTab(setting.path)

    return (
      <SettingItemButton
        key={setting.path}
        isActive={isActive}
        setTab={setTab}
        item={setting}
        path={setting.path}
        onChange={onChange}
        guestLocked={guestLocked}
      />
    )
  })
})

export const SettingModalContentPortal: Component = ({ children }) => {
  const element = useAtomValue(use(SettingModalContentPortalableContext))
  return createPortal(children, element)
}
