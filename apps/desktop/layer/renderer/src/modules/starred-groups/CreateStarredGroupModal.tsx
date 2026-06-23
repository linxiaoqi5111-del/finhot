import { Button } from "@follow/components/ui/button/index.js"
import { Input } from "@follow/components/ui/input/index.js"
import { useInputComposition } from "@follow/hooks"
import { useAtomValue, useSetAtom } from "jotai"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import {
  MAX_CUSTOM_STARRED_GROUPS,
  selectedStarredGroupAtom,
  starredGroupActions,
  starredGroupsAtom,
} from "./store"

export const CreateStarredGroupModalContent = ({
  dismiss,
  onCreated,
}: {
  dismiss: () => void
  onCreated?: (groupId: string) => void
}) => {
  const { t } = useTranslation()
  const [name, setName] = useState("")
  const setSelectedGroup = useSetAtom(selectedStarredGroupAtom)
  const groups = useAtomValue(starredGroupsAtom)
  const compositionInputProps = useInputComposition({
    onKeyDown: (event) => {
      if (event.key === "Escape") {
        dismiss()
      }
    },
  })

  const trimmedName = name.trim()
  const reachedGroupLimit = groups.length >= MAX_CUSTOM_STARRED_GROUPS

  return (
    <form
      className="flex w-[20rem] flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        const groupId = starredGroupActions.create(trimmedName)
        if (!groupId) return

        setSelectedGroup(groupId)
        onCreated?.(groupId)
        dismiss()
      }}
    >
      <Input
        {...compositionInputProps}
        autoFocus
        value={name}
        placeholder={
          reachedGroupLimit
            ? t("starred_groups.max_groups_reached", { ns: "common" })
            : t("starred_groups.name_placeholder", { ns: "common" })
        }
        disabled={reachedGroupLimit}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={dismiss}>
          {t("words.cancel", { ns: "common" })}
        </Button>
        <Button type="submit" disabled={!trimmedName || reachedGroupLimit}>
          {t("words.create", { ns: "common" })}
        </Button>
      </div>
    </form>
  )
}

export const RenameStarredGroupModalContent = ({
  dismiss,
  groupId,
  initialName,
}: {
  dismiss: () => void
  groupId: string
  initialName: string
}) => {
  const { t } = useTranslation()
  const [name, setName] = useState(initialName)
  const compositionInputProps = useInputComposition({
    onKeyDown: (event) => {
      if (event.key === "Escape") {
        dismiss()
      }
    },
  })

  const trimmedName = name.trim()

  return (
    <form
      className="flex w-[20rem] flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        const renamedGroupId = starredGroupActions.rename(groupId, trimmedName)
        if (!renamedGroupId) return

        dismiss()
      }}
    >
      <Input
        {...compositionInputProps}
        autoFocus
        value={name}
        placeholder={t("starred_groups.name_placeholder", { ns: "common" })}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={dismiss}>
          {t("words.cancel", { ns: "common" })}
        </Button>
        <Button type="submit" disabled={!trimmedName || trimmedName === initialName}>
          {t("words.update", { ns: "common" })}
        </Button>
      </div>
    </form>
  )
}
