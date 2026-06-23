import { useAllCollectionEntryList } from "@follow/store/collection/hooks"
import { cn } from "@follow/utils"
import { useAtom } from "jotai"
import type { MouseEvent } from "react"
import { useCallback, useEffect, useMemo } from "react"
import { useTranslation } from "react-i18next"

import { MenuItemSeparator, MenuItemText, useShowContextMenu } from "~/atoms/context-menu"
import { useDialog, useModalStack } from "~/components/ui/modal/stacked/hooks"
import { FEED_COLLECTION_LIST, ROUTE_VIEW_ALL } from "~/constants"
import { useNavigateEntry } from "~/hooks/biz/useNavigateEntry"
import { useRouteParamsSelector } from "~/hooks/biz/useRouteParams"

import {
  CreateStarredGroupModalContent,
  RenameStarredGroupModalContent,
} from "./CreateStarredGroupModal"
import { useStarredGroupAssignments, useStarredGroups } from "./hooks"
import type { StarredGroup, StarredGroupFilter } from "./store"
import {
  MAX_CUSTOM_STARRED_GROUPS,
  selectedStarredGroupAtom,
  STARRED_GROUP_ALL,
  STARRED_GROUP_UNGROUPED,
  starredGroupActions,
} from "./store"

type StarredGroupWithCount = StarredGroup & {
  count: number
}

const GroupRow = ({
  active,
  count,
  icon,
  label,
  onContextMenu,
  onClick,
  variant = "sidebar",
}: {
  active: boolean
  count?: number
  icon?: string
  label: string
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void
  onClick: () => void
  variant?: "sidebar" | "modal"
}) => (
  <button
    type="button"
    className={cn(
      "no-drag-region pointer-events-auto flex w-full items-center gap-1.5 rounded-md font-medium transition-colors",
      variant === "modal"
        ? "h-8 px-2.5 text-sm"
        : "py-0.5 pl-6 pr-2.5 text-base !leading-loose lg:text-sm",
      active
        ? "bg-fill-secondary text-text"
        : "text-text-secondary hover:bg-fill-tertiary hover:text-text",
    )}
    onClick={(event) => {
      event.stopPropagation()
      onClick()
    }}
    onContextMenu={(event) => {
      if (!onContextMenu) return

      event.preventDefault()
      event.stopPropagation()
      onContextMenu(event)
    }}
  >
    {icon && <i className={cn(icon, "size-3.5 shrink-0 text-text-tertiary")} />}
    <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    {typeof count === "number" && (
      <span
        className={cn(
          "ml-2 shrink-0 tabular-nums",
          active ? "text-text-secondary" : "text-text-tertiary",
        )}
      >
        {count}
      </span>
    )}
  </button>
)

const CreateGroupRow = ({
  disabled,
  label,
  onClick,
}: {
  disabled: boolean
  label: string
  onClick: () => void
}) => (
  <button
    type="button"
    disabled={disabled}
    className={cn(
      "no-drag-region pointer-events-auto mx-2.5 my-1 flex h-8 items-center gap-2 rounded-md border border-dashed px-3 text-base font-medium !leading-loose transition-colors lg:text-sm",
      disabled
        ? "cursor-not-allowed border-fill-tertiary text-text-quaternary"
        : "border-text-quaternary text-text-secondary hover:border-text-tertiary hover:bg-fill-tertiary hover:text-text",
    )}
    onClick={(event) => {
      event.stopPropagation()
      if (!disabled) {
        onClick()
      }
    }}
  >
    <i className="i-focal-add size-4 shrink-0" />
    <span className="min-w-0 truncate text-left">{label}</span>
  </button>
)

const useStarredGroupPresentation = () => {
  const groups = useStarredGroups()
  const assignments = useStarredGroupAssignments()
  const collectionEntryIds = useAllCollectionEntryList()

  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    let ungrouped = 0

    for (const entryId of collectionEntryIds) {
      const groupId = assignments[entryId]
      if (!groupId) {
        ungrouped += 1
        continue
      }
      counts[groupId] = (counts[groupId] ?? 0) + 1
    }

    return { byGroupId: counts, ungrouped }
  }, [assignments, collectionEntryIds])

  const sortedGroups = useMemo<StarredGroupWithCount[]>(() => {
    return groups
      .map((group) => ({
        ...group,
        count: groupCounts.byGroupId[group.id] ?? 0,
      }))
      .sort((a, b) => {
        const countDiff = b.count - a.count
        if (countDiff !== 0) return countDiff

        const createdAtDiff = b.createdAt - a.createdAt
        if (createdAtDiff !== 0) return createdAtDiff

        return a.name.localeCompare(b.name)
      })
  }, [groups, groupCounts.byGroupId])

  return { groups, sortedGroups, ungroupedCount: groupCounts.ungrouped }
}

const useOpenCreateStarredGroupModal = ({
  onCreated,
}: {
  onCreated?: (groupId: string) => void
}) => {
  const { t } = useTranslation()
  const { present } = useModalStack()

  return useCallback(() => {
    present({
      title: t("starred_groups.create_title", { ns: "common" }),
      content: ({ dismiss }) => (
        <CreateStarredGroupModalContent dismiss={dismiss} onCreated={onCreated} />
      ),
    })
  }, [onCreated, present, t])
}

export const StarredGroupSidebarActions = ({
  isCollapsed,
  onToggle,
}: {
  isCollapsed: boolean
  onToggle: () => void
}) => {
  const { t } = useTranslation()

  return (
    <div className="no-drag-region pointer-events-none ml-0 flex w-0 shrink-0 items-center overflow-hidden opacity-0 transition-[width,opacity,margin] duration-150 group-hover/scope:pointer-events-auto group-hover/scope:ml-1 group-hover/scope:w-5 group-hover/scope:opacity-100">
      <button
        type="button"
        tabIndex={-1}
        title={t(isCollapsed ? "words.expand" : "words.close", { ns: "common" })}
        className="flex size-5 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-fill-tertiary hover:text-text-secondary"
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
      >
        <i
          className={cn(
            "i-focal-right-fill size-3 shrink-0 transition-transform duration-150",
            !isCollapsed && "rotate-90",
          )}
        />
      </button>
    </div>
  )
}

export const StarredGroupChips = ({
  className,
  collapsed,
}: {
  className?: string
  collapsed: boolean
}) => {
  const { t } = useTranslation()
  const { present } = useModalStack()
  const { ask } = useDialog()
  const showContextMenu = useShowContextMenu()
  const navigateEntry = useNavigateEntry()
  const isCollectionActive = useRouteParamsSelector(
    (params) => params.feedId === FEED_COLLECTION_LIST,
  )
  const { groups, sortedGroups, ungroupedCount } = useStarredGroupPresentation()
  const [selectedGroupId, setSelectedGroupId] = useAtom(selectedStarredGroupAtom)
  const reachedGroupLimit = groups.length >= MAX_CUSTOM_STARRED_GROUPS

  useEffect(() => {
    if (
      selectedGroupId !== STARRED_GROUP_ALL &&
      selectedGroupId !== STARRED_GROUP_UNGROUPED &&
      !groups.some((group) => group.id === selectedGroupId)
    ) {
      setSelectedGroupId(STARRED_GROUP_ALL)
    }
  }, [groups, selectedGroupId, setSelectedGroupId])

  const navigateToCollection = useCallback(() => {
    if (isCollectionActive) return

    navigateEntry({
      timelineId: ROUTE_VIEW_ALL,
      feedId: FEED_COLLECTION_LIST,
      entryId: null,
    })
  }, [isCollectionActive, navigateEntry])

  const setFilter = (groupId: StarredGroupFilter) => {
    setSelectedGroupId(groupId)
    navigateToCollection()
  }

  const openCreateGroupModal = useOpenCreateStarredGroupModal({
    onCreated: () => {
      navigateToCollection()
    },
  })

  const openRenameGroupModal = useCallback(
    (group: StarredGroup) => {
      present({
        title: t("starred_groups.rename_title", { ns: "common" }),
        content: ({ dismiss }) => (
          <RenameStarredGroupModalContent
            dismiss={dismiss}
            groupId={group.id}
            initialName={group.name}
          />
        ),
      })
    },
    [present, t],
  )

  const deleteGroup = useCallback(
    async (group: StarredGroup) => {
      const confirmed = await ask({
        title: t("starred_groups.delete_title", { ns: "common" }),
        message: t("starred_groups.delete_message", { name: group.name, ns: "common" }),
        confirmText: t("starred_groups.delete_group", { ns: "common" }),
        variant: "danger",
      })

      if (confirmed) {
        starredGroupActions.delete(group.id)
      }
    },
    [ask, t],
  )

  const openGroupContextMenu = useCallback(
    async (event: MouseEvent<HTMLButtonElement>, group: StarredGroup) => {
      await showContextMenu(
        [
          new MenuItemText({
            label: t("starred_groups.rename_group", { ns: "common" }),
            icon: <i className="i-focal-edit" />,
            click: () => openRenameGroupModal(group),
          }),
          MenuItemSeparator.default,
          new MenuItemText({
            label: t("starred_groups.delete_group", { ns: "common" }),
            icon: <i className="i-focal-delete-2" />,
            click: () => {
              void deleteGroup(group)
            },
          }),
        ],
        event,
      )
    },
    [deleteGroup, openRenameGroupModal, showContextMenu, t],
  )

  if (collapsed) return null

  return (
    <div className={cn("no-drag-region mt-0.5 flex w-full flex-col gap-px", className)}>
      <CreateGroupRow
        disabled={reachedGroupLimit}
        label={t(
          reachedGroupLimit ? "starred_groups.max_groups_reached" : "starred_groups.new_group",
          { ns: "common" },
        )}
        onClick={openCreateGroupModal}
      />
      <GroupRow
        active={isCollectionActive && selectedGroupId === STARRED_GROUP_UNGROUPED}
        count={ungroupedCount}
        label={t("starred_groups.ungrouped", { ns: "common" })}
        onClick={() => setFilter(STARRED_GROUP_UNGROUPED)}
      />
      {sortedGroups.map((group) => (
        <GroupRow
          key={group.id}
          active={isCollectionActive && selectedGroupId === group.id}
          count={group.count}
          label={group.name}
          onContextMenu={(event) => void openGroupContextMenu(event, group)}
          onClick={() => setFilter(group.id)}
        />
      ))}
    </div>
  )
}
