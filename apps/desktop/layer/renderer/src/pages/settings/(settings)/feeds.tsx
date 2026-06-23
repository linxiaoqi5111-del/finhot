import { SettingFeeds } from "~/modules/settings/tabs/feeds"
import { SettingsTitle } from "~/modules/settings/title"
import { defineSettingPageData } from "~/modules/settings/utils"

const iconName = "i-focal-certificate"
const priority = (1000 << 1) + 30

export const loader = defineSettingPageData({
  icon: iconName,
  name: "titles.feeds",
  priority,
})

export function Component() {
  return (
    <>
      <SettingsTitle />
      <SettingFeeds />
    </>
  )
}
