import { isMobile } from "@follow/components/hooks/useMobile.js"

import { ShortcutSetting } from "~/modules/settings/tabs/shortcut"
import { SettingsTitle } from "~/modules/settings/title"
import { defineSettingPageData } from "~/modules/settings/utils"

const iconName = "i-focal-hotkey"
const priority = (1000 << 1) + 92

export const loader = defineSettingPageData({
  icon: iconName,
  name: "titles.shortcuts",
  priority,
  hideIf: () => isMobile(),
})
export function Component() {
  return (
    <>
      <SettingsTitle />
      <ShortcutSetting />
    </>
  )
}
