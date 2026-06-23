import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { atom, useAtomValue } from "jotai"

import { jotaiStore } from "~/lib/jotai"

import { useGeneralSettingKey } from "./settings/general"

// NOTE: We have three levels of settings can enable AI translation or Summary:
// 1. General setting, which is the global settings for all entries.
// 2. Action setting, which is defined in an action and applied to specific entries.
// 3. Toolbar control, which is a temporary setting for the current entry.
//
// When general setting or action setting is enabled, we hide the toolbar control, which can save some space.
//
// Different from AI summary, AI translation also can show up in the entry list, which should only be controlled by the General setting or Action setting.

const entryTranslationEnabledMapAtom = atom<Record<string, boolean>>({})

export const useShowAITranslationOnce = (entryId: string | undefined) => {
  const map = useAtomValue(entryTranslationEnabledMapAtom)
  return entryId ? !!map[entryId] : false
}

export const getShowAITranslationOnce = (entryId: string) => {
  return !!jotaiStore.get(entryTranslationEnabledMapAtom)[entryId]
}

export const toggleShowAITranslationOnce = (entryId: string) => {
  jotaiStore.set(entryTranslationEnabledMapAtom, (prev) => ({
    ...prev,
    [entryId]: !prev[entryId],
  }))
}

export const enableShowAITranslationOnce = (entryId: string) => {
  jotaiStore.set(entryTranslationEnabledMapAtom, (prev) => ({
    ...prev,
    [entryId]: true,
  }))
}

export const disableShowAITranslationOnce = (entryId: string) => {
  jotaiStore.set(entryTranslationEnabledMapAtom, (prev) => {
    if (!prev[entryId]) return prev
    const next = { ...prev }
    delete next[entryId]
    return next
  })
}

export const useShowAITranslationAuto = (settings?: boolean | null) => {
  const globalTranslation = useGeneralSettingKey("translation")

  if (LOCAL_RSS_MODE) {
    return !!settings
  }

  return globalTranslation || !!settings
}

export const useShowAITranslation = (entryId: string | undefined, settings?: boolean | null) => {
  const showAITranslationOnce = useShowAITranslationOnce(entryId)
  const showAITranslationAuto = useShowAITranslationAuto(settings)

  if (LOCAL_RSS_MODE) {
    return showAITranslationOnce || !!settings
  }

  return showAITranslationAuto || showAITranslationOnce
}

export const useShowTimelineTitleTranslation = (settings?: boolean | null, entryId?: string) => {
  const globalTranslation = useGeneralSettingKey("translation")
  const showAITranslation = useShowAITranslation(entryId, settings)

  if (LOCAL_RSS_MODE) {
    return globalTranslation || !!settings
  }

  return showAITranslation
}
