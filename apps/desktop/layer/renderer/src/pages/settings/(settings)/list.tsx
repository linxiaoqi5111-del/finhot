import { SettingLists } from "~/modules/settings/tabs/lists"
import { SettingsTitle } from "~/modules/settings/title"
import { defineSettingPageData } from "~/modules/settings/utils"

const iconName = "i-focal-rada"
const priority = (1000 << 1) + 200

export const loader = defineSettingPageData({
  icon: iconName,
  name: "titles.lists",
  priority,
  // Hidden from the settings sidebar by product decision; keep the page available for re-enabling later.
  hideIf: () => true,
})

export function Component() {
  return (
    <>
      <SettingsTitle />
      <SettingLists />
    </>
  )
}
