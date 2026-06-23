import type {
  AccentColor,
  AISettings,
  GeneralSettings,
  IntegrationSettings,
  UISettings,
} from "./interface"

export enum SettingPaidLevels {
  Free,
  FreeLimited,
  Basic,
}

type PartialRecord<K extends PropertyKey, V> = Partial<Record<K, V>>

export const PAID_SETTINGS = {
  general: {
    summary: SettingPaidLevels.FreeLimited,
    translation: SettingPaidLevels.Basic,
    translationMode: SettingPaidLevels.Basic,
    hidePrivateSubscriptionsInTimeline: SettingPaidLevels.Basic,
  },
  ui: {},
  integration: {
    enableCubox: SettingPaidLevels.Basic,
    enableObsidian: SettingPaidLevels.Basic,
    enableOutline: SettingPaidLevels.Basic,
    enableReadwise: SettingPaidLevels.Basic,
    enableZotero: SettingPaidLevels.Basic,
    enableInstapaper: SettingPaidLevels.Basic,
    enableReadeck: SettingPaidLevels.Basic,
    enableEagle: SettingPaidLevels.Basic,
    enableQBittorrent: SettingPaidLevels.Basic,
    enableCustomIntegration: SettingPaidLevels.Basic,
  },
  ai: {},
} as const satisfies {
  general: PartialRecord<keyof GeneralSettings, SettingPaidLevels>
  ui: PartialRecord<keyof UISettings, SettingPaidLevels>
  integration: PartialRecord<keyof IntegrationSettings, SettingPaidLevels>
  ai: PartialRecord<keyof AISettings, SettingPaidLevels>
}

export type SettingNamespace = keyof typeof PAID_SETTINGS

export const getSettingPaidLevel = (namespace: string, key: string) => {
  const group = PAID_SETTINGS[namespace as keyof typeof PAID_SETTINGS]
  if (!group) return
  return group[key as keyof typeof group]
}

export const FOCAL_BRAND_ACCENT_COLOR = {
  light: "#E63946",
  dark: "#FF6B6B",
} as const

export const getAccentColorValue = (_color: AccentColor) => {
  return FOCAL_BRAND_ACCENT_COLOR
}
