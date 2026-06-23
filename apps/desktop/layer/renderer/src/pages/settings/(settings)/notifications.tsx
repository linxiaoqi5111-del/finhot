import { LOCAL_RSS_MODE } from "@follow/shared/constants"

import { SettingNotifications } from "~/modules/settings/tabs/notifications"
import { SettingsTitle } from "~/modules/settings/title"
import { defineSettingPageData } from "~/modules/settings/utils"

const iconName = "i-focal-notification"
const priority = (1000 << 1) + 70

// eslint-disable-next-line react-refresh/only-export-components
export const loader = defineSettingPageData({
  icon: iconName,
  name: "titles.notifications",
  priority,
  hideIf: () => LOCAL_RSS_MODE,
})

export function Component() {
  if (LOCAL_RSS_MODE) return null

  return (
    <>
      <SettingsTitle />
      <SettingNotifications />
    </>
  )
}
