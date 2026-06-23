import { useTranslation } from "react-i18next"

import { ActionSetting } from "~/modules/action/action-setting"
import { SettingDescription } from "~/modules/settings/control"
import { SettingsTitle } from "~/modules/settings/title"
import { defineSettingPageData } from "~/modules/settings/utils"

const iconName = "i-focal-magic-2"
const priority = (1000 << 1) + 60

// eslint-disable-next-line react-refresh/only-export-components
export const loader = defineSettingPageData({
  icon: iconName,
  name: "titles.actions",
  priority,
  viewportClassName: "@container",
})

export function Component() {
  const { t } = useTranslation("settings")

  return (
    <>
      <SettingsTitle />
      <SettingDescription className="mt-4 max-w-none">{t("actions.info")}</SettingDescription>
      <div className="relative mt-4 flex min-h-[480px] flex-1 flex-col @container">
        <ActionSetting toolbar="inline" />
      </div>
    </>
  )
}
