import { WindowState } from "@follow/shared/bridge"
import { preventDefault } from "@follow/utils/dom"

import { useWindowState } from "~/atoms/app"
import { useUISettingKey } from "~/atoms/settings/ui"
import { useSubscriptionColumnShow } from "~/atoms/sidebar"
import { ElECTRON_CUSTOM_TITLEBAR_HEIGHT } from "~/constants"
import { SIDEBAR_CARD_INSET } from "~/constants/layout"
import { ipcServices } from "~/lib/client"

export const Titlebar = () => {
  const isMaximized = useWindowState() === WindowState.MAXIMIZED

  const feedColWidth = useUISettingKey("feedColWidth")
  const feedColumnShow = useSubscriptionColumnShow()
  const titlebarLeft = feedColumnShow ? feedColWidth : SIDEBAR_CARD_INSET

  return (
    <div
      onContextMenu={preventDefault}
      className="drag-region absolute right-0 flex items-center justify-end overflow-hidden"
      style={{
        height: `${ElECTRON_CUSTOM_TITLEBAR_HEIGHT}px`,
        left: `${titlebarLeft}px`,
      }}
    >
      <button
        className="no-drag-region pointer-events-auto flex h-full w-[50px] items-center justify-center duration-200 hover:bg-theme-item-active"
        type="button"
        onClick={() => {
          ipcServices?.app.windowAction({ action: "minimize" })
        }}
      >
        <i className="i-focal-minimize" />
      </button>

      <button
        type="button"
        className="no-drag-region pointer-events-auto flex h-full w-[50px] items-center justify-center duration-200 hover:bg-theme-item-active"
        onClick={async () => {
          await ipcServices?.app.windowAction({ action: "maximum" })
        }}
      >
        {isMaximized ? <i className="i-focal-restore" /> : <i className="i-focal-square" />}
      </button>

      <button
        type="button"
        className="no-drag-region pointer-events-auto flex h-full w-[50px] items-center justify-center duration-200 hover:bg-red-500 hover:!text-white"
        onClick={() => {
          ipcServices?.app.windowAction({ action: "close" })
        }}
      >
        <i className="i-focal-close" />
      </button>
    </div>
  )
}
