import { SettingAbout } from "~/modules/settings/tabs/about"
import { SettingsTitle } from "~/modules/settings/title"
import { defineSettingPageData } from "~/modules/settings/utils"

const priority = Number.MAX_SAFE_INTEGER
export const loader = defineSettingPageData({
  icon: "i-focal-information",
  name: "titles.about",
  priority,
})
export const Component = () => (
  <>
    <SettingsTitle />
    <SettingAbout />
  </>
)
