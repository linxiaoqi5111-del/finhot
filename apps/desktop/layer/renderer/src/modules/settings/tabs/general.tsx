import { Input } from "@follow/components/ui/input/index.js"
import { ResponsiveSelect } from "@follow/components/ui/select/responsive.js"
import { useTypeScriptHappyCallback } from "@follow/hooks"
import { IN_ELECTRON, LOCAL_RSS_MODE } from "@follow/shared/constants"
import type { RssRefreshIntervalMinutes } from "@follow/shared/settings/interface"
import { getOS } from "@follow/utils/utils"
import dayjs from "dayjs"
import { useAtom } from "jotai"
import { useEffect } from "react"
import { useTranslation } from "react-i18next"

import { currentSupportedLanguages } from "~/@types/constants"
import { defaultResources } from "~/@types/default-resource"
import { langLoadingLockMapAtom } from "~/atoms/lang"
import {
  setGeneralSetting,
  useGeneralSettingKey,
  useGeneralSettingSelector,
  useGeneralSettingValue,
} from "~/atoms/settings/general"
import { useDialog } from "~/components/ui/modal/stacked/hooks"
import { useProxyValue, useSetProxy } from "~/hooks/biz/useProxySetting"
import { useMinimizeToTrayValue, useSetMinimizeToTray } from "~/hooks/biz/useTraySetting"
import { fallbackLanguage } from "~/i18n"
import { ipcServices } from "~/lib/client"
import { RSS_REFRESH_INTERVAL_OPTIONS } from "~/modules/local-rss/refresh-scheduler"

import { SettingRow, SettingSwitch } from "../control"
import { createSetting } from "../helper/builder"
import {
  useWrapEnhancedSettingItem,
  WrapEnhancedSettingTab,
} from "../hooks/useWrapEnhancedSettingItem"
import { SettingItemGroup } from "../section"

const { defineSettingItem: _defineSettingItem, SettingBuilder } = createSetting(
  "general",
  useGeneralSettingValue,
  setGeneralSetting,
)

const saveLoginSetting = (checked: boolean) => {
  ipcServices?.setting.setLoginItemSettings({
    openAtLogin: checked,
    openAsHidden: true,
    args: ["--startup"],
  })
  setGeneralSetting("appLaunchOnStartup", checked)
}

export const SettingGeneral = () => {
  const { t } = useTranslation("settings")
  useEffect(() => {
    ipcServices?.setting.getLoginItemSettings().then((settings) => {
      if (settings) {
        setGeneralSetting("appLaunchOnStartup", settings.openAtLogin)
      }
    })
  }, [])

  const defineSettingItem = useWrapEnhancedSettingItem(
    _defineSettingItem,
    WrapEnhancedSettingTab.General,
  )

  const { ask } = useDialog()
  const reRenderKey = useGeneralSettingKey("enhancedSettings")

  return (
    <div className="mt-4">
      <SettingBuilder
        key={reRenderKey.toString()}
        settings={[
          {
            type: "title",
            value: t("general.app"),
          },

          defineSettingItem("appLaunchOnStartup", {
            label: t("general.launch_at_login"),
            hide: !ipcServices,
            onChange(value) {
              saveLoginSetting(value)
            },
          }),
          IN_ELECTRON && ["Windows", "Linux"].includes(getOS()) && MinimizeToTraySetting,
          LanguageSelector,

          {
            type: "title",
            value: t("general.subscription"),
          },
          defineSettingItem("autoGroup", {
            label: t("general.auto_group.label"),
            description: t("general.auto_group.description"),
          }),
          defineSettingItem("hideAllReadSubscriptions", {
            label: t("general.hide_all_read_subscriptions.label"),
            description: t("general.hide_all_read_subscriptions.description"),
          }),
          defineSettingItem("hidePrivateSubscriptionsInTimeline", {
            label: t("general.hide_private_subscriptions_in_timeline.label"),
            description: t("general.hide_private_subscriptions_in_timeline.description"),
          }),
          LOCAL_RSS_MODE &&
            defineSettingItem("autoRefreshRss", {
              label: t("general.auto_refresh_rss.label"),
              description: t("general.auto_refresh_rss.description"),
            }),
          LOCAL_RSS_MODE && RssAutoRefreshSubSettings,

          {
            type: "title",
            value: t("general.timeline"),
          },
          defineSettingItem("unreadOnly", {
            label: t("general.show_unread_on_launch.label"),
            description: t("general.show_unread_on_launch.description"),
          }),
          defineSettingItem("groupByDate", {
            label: t("general.group_by_date.label"),
            description: t("general.group_by_date.description"),
          }),
          defineSettingItem("autoExpandLongSocialMedia", {
            label: t("general.auto_expand_long_social_media.label"),
            description: t("general.auto_expand_long_social_media.description"),
          }),
          defineSettingItem("dimRead", {
            label: t("general.dim_read.label"),
            description: t("general.dim_read.description"),
          }),

          { type: "title", value: t("general.mark_as_read.title") },

          defineSettingItem("scrollMarkUnread", {
            label: t("general.mark_as_read.scroll.label"),
            description: t("general.mark_as_read.scroll.description"),
          }),

          defineSettingItem("hoverMarkUnread", {
            label: t("general.mark_as_read.hover.label"),
            description: t("general.mark_as_read.hover.description"),
          }),
          { type: "title", value: t("general.network") },
          IN_ELECTRON && NettingSetting,

          { type: "title", value: t("general.advanced") },

          defineSettingItem("enhancedSettings", {
            label: t("general.enhanced.label"),
            description: t("general.enhanced.description"),
            onChangeGuard(value) {
              if (value) {
                ask({
                  variant: "danger",
                  title: t("general.enhanced.enable.modal.title"),
                  message: t("general.enhanced.enable.modal.description"),
                  confirmText: t("general.enhanced.enable.modal.confirm"),
                  cancelText: t("general.enhanced.enable.modal.cancel"),
                  onConfirm: () => {
                    setGeneralSetting("enhancedSettings", value)
                  },
                })
                return "handled"
              }
            },
          }),
        ]}
      />
    </div>
  )
}

const RssAutoRefreshSubSettings = () => {
  const { t } = useTranslation("settings")
  const autoRefreshRss = useGeneralSettingKey("autoRefreshRss")
  const autoRefreshRssOnWake = useGeneralSettingKey("autoRefreshRssOnWake")
  const intervalMinutes = useGeneralSettingKey("autoRefreshRssIntervalMinutes")

  if (!autoRefreshRss) return null

  return (
    <>
      <SettingItemGroup>
        <SettingRow
          label={t("general.auto_refresh_rss_interval.label")}
          description={t("general.auto_refresh_rss_interval.description")}
        >
          <ResponsiveSelect
            size="sm"
            triggerClassName="w-48 shrink-0"
            value={String(intervalMinutes)}
            onValueChange={(value) => {
              setGeneralSetting(
                "autoRefreshRssIntervalMinutes",
                Number(value) as RssRefreshIntervalMinutes,
              )
            }}
            items={RSS_REFRESH_INTERVAL_OPTIONS.map((minutes) => ({
              label: t("general.auto_refresh_rss_interval.option", { count: minutes }),
              value: String(minutes),
            }))}
          />
        </SettingRow>
      </SettingItemGroup>
      <SettingItemGroup>
        <SettingSwitch
          checked={autoRefreshRssOnWake}
          onCheckedChange={(checked) => setGeneralSetting("autoRefreshRssOnWake", checked)}
          label={t("general.auto_refresh_rss_on_wake.label")}
          description={t("general.auto_refresh_rss_on_wake.description")}
        />
      </SettingItemGroup>
    </>
  )
}

export const LanguageSelector = ({
  containerClassName,
  contentClassName,

  showDescription = true,
}: {
  containerClassName?: string
  contentClassName?: string
  showDescription?: boolean
}) => {
  const { t } = useTranslation("settings")
  const language = useGeneralSettingSelector((state) => state.language)

  const finalRenderLanguage = currentSupportedLanguages.includes(language)
    ? language
    : fallbackLanguage

  const [loadingLanguageLockMap] = useAtom(langLoadingLockMapAtom)

  return (
    <SettingItemGroup className={containerClassName}>
      <SettingRow
        label={t("general.language.title")}
        description={showDescription ? t("general.language.description") : undefined}
      >
        <ResponsiveSelect
          size="sm"
          triggerClassName="w-48 shrink-0"
          triggerTestId="settings-language-select"
          contentClassName={contentClassName}
          defaultValue={finalRenderLanguage}
          value={finalRenderLanguage}
          disabled={loadingLanguageLockMap[finalRenderLanguage]}
          onValueChange={(value) => {
            setGeneralSetting("language", value as string)
            dayjs.locale(value)
          }}
          renderValue={useTypeScriptHappyCallback((item) => {
            return <span>{defaultResources[item.value].lang.name}</span>
          }, [])}
          renderItem={useTypeScriptHappyCallback((item) => {
            const lang = item.value
            const percent = I18N_COMPLETENESS_MAP[lang]

            const originalLanguageName = defaultResources[lang].lang.name

            return (
              <span className="group" key={lang}>
                <span>
                  {originalLanguageName}
                  {typeof percent === "number" ? (percent >= 100 ? null : ` (${percent}%)`) : null}
                </span>
              </span>
            )
          }, [])}
          items={currentSupportedLanguages.map((lang) => ({
            label: `langs.${lang}`,
            value: lang,
          }))}
        />
      </SettingRow>
    </SettingItemGroup>
  )
}

const NettingSetting = () => {
  const { t } = useTranslation("settings")
  const proxyConfig = useProxyValue()
  const setProxyConfig = useSetProxy()

  return (
    <SettingItemGroup>
      <SettingRow label={t("general.proxy.label")} description={t("general.proxy.description")}>
        <Input
          type="text"
          value={proxyConfig}
          onChange={(event) => setProxyConfig(event.target.value.trim())}
          className="w-72 max-w-full bg-background text-sm"
        />
      </SettingRow>
    </SettingItemGroup>
  )
}

const MinimizeToTraySetting = () => {
  const { t } = useTranslation("settings")
  const minimizeToTray = useMinimizeToTrayValue()
  const setMinimizeToTray = useSetMinimizeToTray()
  return (
    <SettingItemGroup>
      <SettingSwitch
        checked={minimizeToTray}
        onCheckedChange={setMinimizeToTray}
        label={t("general.minimize_to_tray.label")}
        description={t("general.minimize_to_tray.description")}
      />
    </SettingItemGroup>
  )
}
