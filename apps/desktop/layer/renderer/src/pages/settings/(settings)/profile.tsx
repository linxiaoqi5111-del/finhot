import { EmailManagement } from "~/modules/profile/email-management"
import { ProfileSettingForm } from "~/modules/profile/profile-setting-form"
import { SettingsTitle } from "~/modules/settings/title"
import { defineSettingPageData } from "~/modules/settings/utils"

const iconName = "i-focal-user-setting"
const priority = (1000 << 1) + 95
export const loader = defineSettingPageData({
  icon: iconName,
  name: "titles.account",
  priority,
  // Hidden from the settings sidebar by product decision (local-only fork has no login).
  hideIf: () => true,
})

export function Component() {
  return (
    <>
      <SettingsTitle />
      <section className="mt-4">
        <EmailManagement />
        <ProfileSettingForm />
      </section>
    </>
  )
}
