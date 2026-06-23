import { LOCAL_RSS_MODE } from "@follow/shared/constants"

import { useSubViewTitle } from "~/modules/app-layout/subview/hooks"
import { RSSHubSetting } from "~/modules/rsshub/RSSHubSetting"

export function Component() {
  useSubViewTitle("words.rsshub")
  if (LOCAL_RSS_MODE) return null

  return <RSSHubSetting headerAction="subview" />
}
