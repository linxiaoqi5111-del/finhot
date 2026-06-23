import { EllipsisHorizontalTextWithTooltip } from "@follow/components/ui/typography/index.js"
import { cn } from "@follow/utils/utils"
import { Slot } from "@radix-ui/react-slot"
import { use } from "react"
import { useTranslation } from "react-i18next"
import { useLoaderData } from "react-router"

import { IsInSettingIndependentWindowContext } from "./context"
import { getMemoizedSettings } from "./settings-glob"
import type { SettingPageConfig } from "./utils"

export const SettingsSidebarTitle = ({
  path,
  active = false,
  className,
}: {
  path: string
  active?: boolean
  className?: string
}) => {
  const { t } = useTranslation("settings")
  const tab = getMemoizedSettings().find((t) => t.path === path)

  if (!tab) {
    return null
  }

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 text-sm leading-5",
        active ? "font-semibold" : "font-medium",
        className,
      )}
    >
      {typeof tab.icon === "string" ? (
        <i
          className={cn(
            tab.icon,
            "shrink-0 text-[17px] transition-colors",
            active
              ? "text-current opacity-90"
              : "text-text-tertiary group-hover/settings-tab:text-text-secondary",
          )}
        />
      ) : (
        <Slot
          className={cn(
            "shrink-0 text-[17px] transition-colors",
            active
              ? "text-current opacity-90"
              : "text-text-tertiary group-hover/settings-tab:text-text-secondary",
          )}
        >
          {tab.icon}
        </Slot>
      )}
      <EllipsisHorizontalTextWithTooltip>{t(tab.name as any)}</EllipsisHorizontalTextWithTooltip>
    </div>
  )
}

export const SettingsTitle = ({
  className,
  loader,
}: {
  className?: string
  loader?: () => SettingPageConfig
}) => {
  const { t } = useTranslation("settings")
  const { name, title } = (useLoaderData() || loader || {}) as SettingPageConfig

  const usedTitle = title || name
  const isInSettingIndependentWindow = use(IsInSettingIndependentWindowContext)
  if (!usedTitle) {
    return null
  }
  return (
    <div
      className={cn(
        "flex items-center gap-2 pb-3 pt-6 text-xl font-bold tracking-normal text-text",
        "sticky top-0 mb-3",
        isInSettingIndependentWindow ? "z-[99] bg-background" : "",
        className,
      )}
    >
      <span>{t(usedTitle)}</span>
    </div>
  )
}
