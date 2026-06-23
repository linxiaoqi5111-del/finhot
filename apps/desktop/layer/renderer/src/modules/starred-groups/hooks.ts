import { useAtomValue } from "jotai"

import { starredGroupAssignmentsAtom, starredGroupsAtom } from "./store"

export const useStarredGroups = () => useAtomValue(starredGroupsAtom)

export const useStarredGroupAssignments = () => useAtomValue(starredGroupAssignmentsAtom)

export const useStarredGroupAssignment = (entryId: string) =>
  useAtomValue(starredGroupAssignmentsAtom)[entryId]
