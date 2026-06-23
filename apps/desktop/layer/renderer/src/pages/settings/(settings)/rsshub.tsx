import { RSSHubLogo } from "@follow/components/ui/platform-icon/icons.js"
import { LOCAL_RSS_MODE } from "@follow/shared/constants"

import { RSSHubSetting } from "~/modules/rsshub/RSSHubSetting"
import { SettingsTitle } from "~/modules/settings/title"
import { defineSettingPageData } from "~/modules/settings/utils"

const priority = (1000 << 1) + 90

// eslint-disable-next-line react-refresh/only-export-components
export const loader = defineSettingPageData({
  icon: <RSSHubLogo className="size-[19px]" />,
  name: "titles.rsshub",
  priority,
  hideIf: (ctx) => LOCAL_RSS_MODE || ctx.isInMASReview,
})

export function Component() {
  if (LOCAL_RSS_MODE) return null

  return (
    <>
      <SettingsTitle />
      <RSSHubSetting className="px-0 py-0" />
    </>
  )
}
