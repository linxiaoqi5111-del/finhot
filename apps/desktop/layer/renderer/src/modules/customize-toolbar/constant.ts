import type { UniqueIdentifier } from "@dnd-kit/core"

import { COMMAND_ID } from "../command/commands/id"

export interface ToolbarActionOrder {
  main: UniqueIdentifier[]
  more: UniqueIdentifier[]
}

export const ENTRY_ITEM_HIDE_IN_HEADER = new Set<UniqueIdentifier>([
  COMMAND_ID.entry.readAbove,
  COMMAND_ID.entry.readBelow,
  COMMAND_ID.settings.customizeToolbar,
])

const MAIN_ACTIONS = [
  COMMAND_ID.global.quickSearch,
  COMMAND_ID.entry.read,
  COMMAND_ID.entry.star,
  COMMAND_ID.entry.notInterested,

  COMMAND_ID.entry.readability,
  COMMAND_ID.entry.toggleAITranslation,

  COMMAND_ID.entry.share,
]
const MAIN_ACTIONS_SET = new Set<UniqueIdentifier>(MAIN_ACTIONS)

export const DEFAULT_ACTION_ORDER: ToolbarActionOrder = {
  main: MAIN_ACTIONS,
  more: [
    ...Object.values(COMMAND_ID.integration),
    ...Object.values(COMMAND_ID.entry).filter((id) => !MAIN_ACTIONS_SET.has(id)),
  ],
}

const mergeActionListByDefaultOrder = (
  current: UniqueIdentifier[],
  defaultList: UniqueIdentifier[],
  existingIds: Set<UniqueIdentifier>,
) => {
  const merged = [...current]

  for (const defaultId of defaultList) {
    if (existingIds.has(defaultId)) continue

    const defaultIndex = defaultList.indexOf(defaultId)
    const insertIndex = merged.findIndex((id) => {
      const nextDefaultIndex = defaultList.indexOf(id)
      return nextDefaultIndex > defaultIndex
    })

    if (insertIndex === -1) {
      merged.push(defaultId)
    } else {
      merged.splice(insertIndex, 0, defaultId)
    }
    existingIds.add(defaultId)
  }

  return merged
}

export const mergeToolbarActionOrder = (actionOrder: ToolbarActionOrder): ToolbarActionOrder => {
  const existingIds = new Set([...actionOrder.main, ...actionOrder.more])

  return {
    main: mergeActionListByDefaultOrder(actionOrder.main, DEFAULT_ACTION_ORDER.main, existingIds),
    more: mergeActionListByDefaultOrder(actionOrder.more, DEFAULT_ACTION_ORDER.more, existingIds),
  }
}
