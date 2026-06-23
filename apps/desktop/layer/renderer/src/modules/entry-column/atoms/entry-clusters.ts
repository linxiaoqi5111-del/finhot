import type { EntryCluster } from "@follow/store/entry-embedding/cluster"
import { atom } from "jotai"

export type ClusterMap = {
  /** entryId -> cluster it belongs to */
  memberOf: Record<string, EntryCluster>
  /** leader entryId -> cluster */
  leaders: Record<string, EntryCluster>
  /** entryIds that are non-leader cluster members (should be hidden) */
  hiddenByCluster: Set<string>
  /** Set of leader entryIds whose cluster is currently expanded */
  expandedLeaders: Set<string>
}

const emptyClusterMap: ClusterMap = {
  memberOf: {},
  leaders: {},
  hiddenByCluster: new Set(),
  expandedLeaders: new Set(),
}

export const clusterMapAtom = atom<ClusterMap>(emptyClusterMap)

export const expandedClusterLeadersAtom = atom<Set<string>>(new Set())
