import { createSettingAtom } from "@follow/atoms/helper/setting.js"
import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { defaultAISettings } from "@follow/shared/settings/defaults"
import type {
  AISettings,
  AIShortcut,
  AIShortcutTarget,
  MCPService,
} from "@follow/shared/settings/interface"
import { DEFAULT_SHORTCUT_TARGETS } from "@follow/shared/settings/interface"
import { jotaiStore } from "@follow/utils"
import type { ExtractResponseData, GetStatusConfigsResponse } from "@follow-app/client-sdk"
import { clamp } from "es-toolkit"
import { atom, useAtomValue } from "jotai"

import { getFeature } from "~/hooks/biz/useFeature"

export interface WebAISettings extends AISettings {
  panelStyle: AIChatPanelStyle
  showSplineButton: boolean
}

type ServerShortcutConfig = ExtractResponseData<GetStatusConfigsResponse>["AI_SHORTCUTS"][number]

const FALLBACK_SHORTCUT_ICON = "i-focal-hotkey"
const VALID_SHORTCUT_TARGETS = new Set<AIShortcutTarget>(DEFAULT_SHORTCUT_TARGETS)

const isValidShortcutTarget = (target: string): target is AIShortcutTarget =>
  VALID_SHORTCUT_TARGETS.has(target as AIShortcutTarget)

const sanitizeShortcutTargets = (targets?: readonly string[]): AIShortcutTarget[] => {
  if (!targets || targets.length === 0) {
    return [...DEFAULT_SHORTCUT_TARGETS]
  }

  const filtered = targets.filter(isValidShortcutTarget) as AIShortcutTarget[]
  return filtered.length > 0 ? [...filtered] : [...DEFAULT_SHORTCUT_TARGETS]
}

const normalizeShortcut = (shortcut: AIShortcut): AIShortcut => {
  return {
    ...shortcut,
    displayTargets: sanitizeShortcutTargets(shortcut.displayTargets),
    enabled: typeof shortcut.enabled === "boolean" ? shortcut.enabled : true,
  }
}

const normalizeShortcuts = (shortcuts: readonly AIShortcut[] | undefined): AIShortcut[] =>
  (shortcuts ?? []).map((shortcut) => normalizeShortcut({ ...shortcut }))

const mergeWithServerShortcuts = (
  localShortcuts: readonly AIShortcut[],
  serverShortcuts: readonly ServerShortcutConfig[],
): AIShortcut[] => {
  const normalizedLocal = normalizeShortcuts(localShortcuts)
  if (serverShortcuts.length === 0) {
    return normalizedLocal
  }

  const serverShortcutMap = new Map<string, ServerShortcutConfig>()
  serverShortcuts.forEach((shortcut) => {
    serverShortcutMap.set(shortcut.id, shortcut)
  })

  const seenServerShortcutIds = new Set<string>()
  const mergedShortcuts: AIShortcut[] = []

  normalizedLocal.forEach((shortcut) => {
    const serverShortcut = serverShortcutMap.get(shortcut.id)
    if (!serverShortcut) {
      mergedShortcuts.push(shortcut)
      return
    }

    seenServerShortcutIds.add(serverShortcut.id)
    const shouldClearPrompt = shortcut.prompt === serverShortcut.defaultPrompt

    mergedShortcuts.push({
      ...shortcut,
      name: shortcut.name || serverShortcut.name,
      prompt: shouldClearPrompt ? "" : shortcut.prompt,
      defaultPrompt: serverShortcut.defaultPrompt,
      displayTargets: sanitizeShortcutTargets(
        shortcut.displayTargets || serverShortcut.displayTargets,
      ),
    })
  })

  serverShortcuts.forEach((serverShortcut) => {
    if (seenServerShortcutIds.has(serverShortcut.id)) return

    mergedShortcuts.push({
      id: serverShortcut.id,
      name: serverShortcut.name,
      prompt: "",
      defaultPrompt: serverShortcut.defaultPrompt,
      enabled: true,
      icon: FALLBACK_SHORTCUT_ICON,
      displayTargets: sanitizeShortcutTargets(serverShortcut.displayTargets),
    })
  })

  return mergedShortcuts
}

export const getShortcutEffectivePrompt = (shortcut: AIShortcut): string => {
  return shortcut.prompt || shortcut.defaultPrompt || ""
}

export const isServerShortcut = (shortcut: AIShortcut) => !!shortcut.defaultPrompt

export const createDefaultSettings = (): WebAISettings => ({
  ...defaultAISettings,
  shortcuts: normalizeShortcuts(defaultAISettings.shortcuts),
  panelStyle: AIChatPanelStyle.Floating,
  showSplineButton: !LOCAL_RSS_MODE,
})

export const {
  useSettingKey: useAISettingKey,
  useSettingSelector: useAISettingSelector,
  setSetting: setAISetting,
  clearSettings: clearAISettings,
  initializeDefaultSettings,
  getSettings: getAISettings,
  useSettingValue: useAISettingValue,
  settingAtom: __aiSettingAtom,
} = createSettingAtom("ai", createDefaultSettings)
export const aiServerSyncWhiteListKeys = []

export const syncServerShortcuts = (
  serverShortcuts: readonly ServerShortcutConfig[] | null | undefined,
) => {
  const storedShortcuts = getAISettings().shortcuts ?? []
  const serverShortcutList = Array.isArray(serverShortcuts) ? serverShortcuts : []
  const mergedShortcuts = mergeWithServerShortcuts(storedShortcuts, serverShortcutList)

  setAISetting("shortcuts", mergedShortcuts)
}

////////// AI Panel Style
export enum AIChatPanelStyle {
  Fixed = "fixed",
  Floating = "floating",
}

export const useAIChatPanelStyle = () => useAISettingKey("panelStyle")
export const setAIChatPanelStyle = (style: AIChatPanelStyle) => {
  setAISetting("panelStyle", style)
}
export const getAIChatPanelStyle = () => getAISettings().panelStyle

// Floating panel state atoms
interface FloatingPanelState {
  width: number
  height: number
  x: number
  y: number
}

export const FLOATING_PANEL_VIEWPORT_MARGIN = 32
export const FLOATING_PANEL_MIN_WIDTH = 500
export const FLOATING_PANEL_MIN_HEIGHT = 420
export const FLOATING_PANEL_MAX_WIDTH = 800

export const getFloatingPanelMaxHeight = () =>
  Math.max(
    FLOATING_PANEL_MIN_HEIGHT,
    Math.floor(window.innerHeight - FLOATING_PANEL_VIEWPORT_MARGIN * 2),
  )

const DEFAULT_FLOATING_PANEL_WIDTH = FLOATING_PANEL_MIN_WIDTH
const DEFAULT_FLOATING_PANEL_HEIGHT = clamp(
  (window.innerHeight * 3) / 4,
  FLOATING_PANEL_MIN_HEIGHT,
  getFloatingPanelMaxHeight(),
)

export const clampFloatingPanelPosition = (x: number, y: number, width: number, height: number) => {
  const maxX = Math.max(
    FLOATING_PANEL_VIEWPORT_MARGIN,
    window.innerWidth - width - FLOATING_PANEL_VIEWPORT_MARGIN,
  )
  const maxY = Math.max(
    FLOATING_PANEL_VIEWPORT_MARGIN,
    window.innerHeight - height - FLOATING_PANEL_VIEWPORT_MARGIN,
  )

  return {
    x: Math.min(Math.max(FLOATING_PANEL_VIEWPORT_MARGIN, x), maxX),
    y: Math.min(Math.max(FLOATING_PANEL_VIEWPORT_MARGIN, y), maxY),
  }
}

const getDefaultFloatingPanelPosition = (width: number, height: number) =>
  clampFloatingPanelPosition(
    window.innerWidth - width - FLOATING_PANEL_VIEWPORT_MARGIN,
    window.innerHeight - height - FLOATING_PANEL_VIEWPORT_MARGIN,
    width,
    height,
  )

const defaultFloatingPanelPosition = getDefaultFloatingPanelPosition(
  DEFAULT_FLOATING_PANEL_WIDTH,
  DEFAULT_FLOATING_PANEL_HEIGHT,
)

const defaultFloatingPanelState: FloatingPanelState = {
  width: DEFAULT_FLOATING_PANEL_WIDTH,
  height: DEFAULT_FLOATING_PANEL_HEIGHT,
  x: defaultFloatingPanelPosition.x,
  y: defaultFloatingPanelPosition.y,
}

const floatingPanelStateAtom = atom<FloatingPanelState>(defaultFloatingPanelState)

export const useFloatingPanelState = () => useAtomValue(floatingPanelStateAtom)
export const setFloatingPanelState = (state: Partial<FloatingPanelState>) => {
  const currentState = jotaiStore.get(floatingPanelStateAtom)
  jotaiStore.set(floatingPanelStateAtom, { ...currentState, ...state })
}
export const getFloatingPanelState = () => jotaiStore.get(floatingPanelStateAtom)
export const resetFloatingPanelPosition = () => {
  const currentState = jotaiStore.get(floatingPanelStateAtom)
  jotaiStore.set(floatingPanelStateAtom, {
    ...currentState,
    ...getDefaultFloatingPanelPosition(currentState.width, currentState.height),
  })
}

////////// AI Panel Visibility

const aiPanelVisibilityAtom = atom<boolean>(false)
export const useAIPanelVisibility = () => useAtomValue(aiPanelVisibilityAtom)
export const setAIPanelVisibility = (visibility: boolean) => {
  const aiEnabled = getFeature("ai")
  if (aiEnabled) {
    if (visibility) {
      resetFloatingPanelPosition()
    }
    jotaiStore.set(aiPanelVisibilityAtom, visibility)
  }
}
export const getAIPanelVisibility = () => jotaiStore.get(aiPanelVisibilityAtom)

////////// MCP Services
export const useMCPEnabled = () => useAISettingKey("mcpEnabled")
export const setMCPEnabled = (enabled: boolean) => {
  setAISetting("mcpEnabled", enabled)
}

export const useMCPServices = () => useAISettingKey("mcpServices")
export const addMCPService = (service: Omit<MCPService, "id">) => {
  const services = getAISettings().mcpServices
  const newService = {
    ...service,
    id: Date.now().toString(),
  }
  setAISetting("mcpServices", [...services, newService])
  return newService.id
}

export const updateMCPService = (id: string, updates: Partial<MCPService>) => {
  const services = getAISettings().mcpServices
  const updatedServices = services.map((service) =>
    service.id === id ? { ...service, ...updates } : service,
  )
  setAISetting("mcpServices", updatedServices)
}

export const removeMCPService = (id: string) => {
  const services = getAISettings().mcpServices
  const filteredServices = services.filter((service) => service.id !== id)
  setAISetting("mcpServices", filteredServices)
}

//// Enhance Init Ai Settings
export const initializeDefaultAISettings = () => {
  initializeDefaultSettings()
}
