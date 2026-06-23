import type { UniqueIdentifier } from "@dnd-kit/core"
import { useMemo } from "react"

import { useUISettingSelector } from "~/atoms/settings/ui"

import { ENTRY_ITEM_HIDE_IN_HEADER, mergeToolbarActionOrder } from "./constant"

export const useActionOrder = () => {
  const actionOrderSetting = useUISettingSelector((s) => s.toolbarOrder)

  return useMemo(() => {
    const actionOrder = mergeToolbarActionOrder(actionOrderSetting)

    return {
      main: actionOrder.main.filter((id) => !ENTRY_ITEM_HIDE_IN_HEADER.has(id as string)),
      more: actionOrder.more.filter((id) => !ENTRY_ITEM_HIDE_IN_HEADER.has(id as string)),
    }
  }, [actionOrderSetting])
}

export const useToolbarOrderMap = () => {
  const actionOrder = useActionOrder()

  const actionOrderMap = useMemo(() => {
    const actionOrderMap = new Map<
      UniqueIdentifier,
      {
        type: "main" | "more"
        order: number
      }
    >()
    actionOrder.main.forEach((id, index) =>
      actionOrderMap.set(id, {
        type: "main",
        order: index,
      }),
    )
    actionOrder.more.forEach((id, index) =>
      actionOrderMap.set(id, {
        type: "more",
        order: index,
      }),
    )
    return actionOrderMap
  }, [actionOrder])

  return actionOrderMap
}
