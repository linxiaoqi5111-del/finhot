import { getStorageNS } from "@follow/utils/ns"
import { atomWithStorage } from "jotai/utils"

export const recommendedTimelineEnabledAtom = atomWithStorage(
  getStorageNS("recommended-timeline-enabled"),
  false,
)
