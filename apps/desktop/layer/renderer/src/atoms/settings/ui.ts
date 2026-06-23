import { createSettingAtom } from "@follow/atoms/helper/setting.js"
import { defaultUISettings } from "@follow/shared/settings/defaults"
import type { UISettings } from "@follow/shared/settings/interface"

import { getDefaultLanguage } from "~/lib/language"
import { DEFAULT_ACTION_ORDER } from "~/modules/customize-toolbar/constant"

import { hookEnhancedSettings } from "./general"

export const createDefaultUISettings = (): UISettings => ({
  ...defaultUISettings,
  // Action Order
  toolbarOrder: DEFAULT_ACTION_ORDER,
  // Discover
  discoverLanguage: getDefaultLanguage().startsWith("zh") ? "all" : "eng",
})

const {
  useSettingKey: useUISettingKeyInternal,
  useSettingSelector: useUISettingSelectorInternal,
  useSettingKeys: useUISettingKeysInternal,
  setSetting: setUISetting,
  clearSettings: clearUISettings,
  initializeDefaultSettings: initializeDefaultUISettings,
  getSettings: getUISettingsInternal,
  useSettingValue: useUISettingValueInternal,
  settingAtom: __uiSettingAtom,
} = createSettingAtom("ui", createDefaultUISettings)

export const uiServerSyncWhiteListKeys: (keyof UISettings)[] = [
  "uiFontFamily",
  "readerFontFamily",
  // "customCSS",
]

export const enhancedUISettingKeys = new Set<keyof UISettings>([
  "codeHighlightThemeLight",
  "codeHighlightThemeDark",
  "readerRenderInlineStyle",
  "modalOverlay",
  "reduceMotion",
  "usePointerCursor",
])

const [useUISettingKey, useUISettingSelector, useUISettingKeys, getUISettings, useUISettingValue] =
  hookEnhancedSettings(
    useUISettingKeyInternal,
    useUISettingSelectorInternal,
    useUISettingKeysInternal,
    getUISettingsInternal,
    useUISettingValueInternal,

    enhancedUISettingKeys,
    defaultUISettings,
  )
export {
  __uiSettingAtom,
  clearUISettings,
  getUISettings,
  initializeDefaultUISettings,
  setUISetting,
  useUISettingKey,
  useUISettingKeys,
  useUISettingSelector,
  useUISettingValue,
}
