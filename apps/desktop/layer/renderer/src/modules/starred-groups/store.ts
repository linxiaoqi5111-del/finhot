import { getStorageNS } from "@follow/utils/ns"
import { atomWithStorage } from "jotai/utils"

import { jotaiStore } from "~/lib/jotai"

export type StarredGroup = {
  id: string
  name: string
  createdAt: number
}

export type StarredGroupAssignments = Record<string, string>

export const STARRED_GROUP_ALL = "__all__"
export const STARRED_GROUP_UNGROUPED = "__ungrouped__"
export const MAX_CUSTOM_STARRED_GROUPS = 6
export const STARRED_GROUPS_ENABLED = false

export type StarredGroupFilter = typeof STARRED_GROUP_ALL | typeof STARRED_GROUP_UNGROUPED | string

export const starredGroupsAtom = atomWithStorage<StarredGroup[]>(getStorageNS("starred-groups"), [])

export const starredGroupAssignmentsAtom = atomWithStorage<StarredGroupAssignments>(
  getStorageNS("starred-group-assignments"),
  {},
)

export const starredGroupsCollapsedAtom = atomWithStorage<boolean>(
  getStorageNS("sidebar-starred-groups-collapsed"),
  true,
)

export const selectedStarredGroupAtom = atomWithStorage<StarredGroupFilter>(
  getStorageNS("selected-starred-group"),
  STARRED_GROUP_ALL,
)

const store = jotaiStore

const genId = () =>
  `starred_group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

export const doesEntryMatchStarredGroupFilter = ({
  entryId,
  selectedGroupId,
  assignments,
}: {
  entryId: string
  selectedGroupId: StarredGroupFilter
  assignments: StarredGroupAssignments
}) => {
  if (!STARRED_GROUPS_ENABLED) return true
  if (selectedGroupId === STARRED_GROUP_ALL) return true

  const assignedGroupId = assignments[entryId]
  if (selectedGroupId === STARRED_GROUP_UNGROUPED) return !assignedGroupId

  return assignedGroupId === selectedGroupId
}

export const starredGroupActions = {
  create(name: string) {
    const trimmed = name.trim()
    if (!trimmed) return

    const groups = store.get(starredGroupsAtom)
    const existing = groups.find((group) => group.name.toLowerCase() === trimmed.toLowerCase())
    if (existing) return existing.id
    if (groups.length >= MAX_CUSTOM_STARRED_GROUPS) return

    const group: StarredGroup = {
      id: genId(),
      name: trimmed,
      createdAt: Date.now(),
    }
    store.set(starredGroupsAtom, [...groups, group])
    return group.id
  },

  rename(groupId: string, name: string) {
    const trimmed = name.trim()
    if (!trimmed) return

    const groups = store.get(starredGroupsAtom)
    const existing = groups.find(
      (group) => group.id !== groupId && group.name.toLowerCase() === trimmed.toLowerCase(),
    )
    if (existing) return

    store.set(
      starredGroupsAtom,
      groups.map((group) => (group.id === groupId ? { ...group, name: trimmed } : group)),
    )
    return groupId
  },

  delete(groupId: string) {
    const groups = store.get(starredGroupsAtom)
    store.set(
      starredGroupsAtom,
      groups.filter((group) => group.id !== groupId),
    )

    const assignments = store.get(starredGroupAssignmentsAtom)
    const nextAssignments = { ...assignments }
    Object.entries(assignments).forEach(([entryId, assignedGroupId]) => {
      if (assignedGroupId === groupId) {
        delete nextAssignments[entryId]
      }
    })
    store.set(starredGroupAssignmentsAtom, nextAssignments)

    if (store.get(selectedStarredGroupAtom) === groupId) {
      store.set(selectedStarredGroupAtom, STARRED_GROUP_ALL)
    }
  },

  assignEntryToGroup(entryId: string, groupId?: string) {
    const assignments = store.get(starredGroupAssignmentsAtom)
    const nextAssignments = { ...assignments }

    if (groupId) {
      nextAssignments[entryId] = groupId
    } else {
      delete nextAssignments[entryId]
    }

    store.set(starredGroupAssignmentsAtom, nextAssignments)
  },
}
