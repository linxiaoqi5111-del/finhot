import { defaultUISettings } from "@follow/shared/settings/defaults"

const ENTRY_COLUMN_DEFAULT_RATIO = 0.38
const ENTRY_COLUMN_RESPONSIVE_MIN_WIDTH = 360
const ENTRY_COLUMN_RESPONSIVE_MAX_WIDTH = 560

const clampResponsiveEntryColumnWidth = (width: number) =>
  Math.max(ENTRY_COLUMN_RESPONSIVE_MIN_WIDTH, Math.min(width, ENTRY_COLUMN_RESPONSIVE_MAX_WIDTH))

export const resolveDefaultEntryColumnWidth = (windowWidth: number, feedColumnWidth: number) => {
  const availableWidth = Math.max(windowWidth - feedColumnWidth, 0)
  return clampResponsiveEntryColumnWidth(Math.round(availableWidth * ENTRY_COLUMN_DEFAULT_RATIO))
}

export const resolveInitialEntryColumnWidth = (
  savedWidth: number,
  windowWidth: number,
  feedColumnWidth: number,
) => {
  if (savedWidth === defaultUISettings.entryColWidth) {
    return resolveDefaultEntryColumnWidth(windowWidth, feedColumnWidth)
  }

  return savedWidth
}

export const resolveResetEntryColumnWidth = (windowWidth: number, feedColumnWidth: number) =>
  resolveDefaultEntryColumnWidth(windowWidth, feedColumnWidth)
