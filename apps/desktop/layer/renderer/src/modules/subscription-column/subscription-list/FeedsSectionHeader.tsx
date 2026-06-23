import { ActionButton } from "@follow/components/ui/button/index.js"
import type { FeedViewType } from "@follow/constants"
import { cn } from "@follow/utils/utils"
import { useTranslation } from "react-i18next"

import { useCategoryCreationModal } from "~/modules/settings/tabs/lists/hooks"

import { SortButton } from "./SortButton"

export const FeedsSectionHeader = ({
  className,
  isOpen,
  onToggle,
  view,
}: {
  className?: string
  isOpen: boolean
  onToggle: () => void
  view: FeedViewType
}) => {
  const { t } = useTranslation()
  const presentCategoryCreationModal = useCategoryCreationModal()

  return (
    <div className={cn("group/feeds-header flex items-center gap-1", className)}>
      <button
        type="button"
        data-selecto-ignore
        aria-expanded={isOpen}
        className={cn(
          "no-drag-region pointer-events-auto flex h-6 min-w-0 flex-1 items-center rounded-md px-2.5 text-left text-xs font-semibold text-text-secondary transition-colors hover:bg-fill-secondary hover:text-text",
        )}
        onPointerDown={(event) => {
          event.stopPropagation()
        }}
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
      >
        <span className="min-w-0 flex-1 truncate">{t("words.feeds")}</span>
        <i
          aria-hidden
          className={cn(
            "i-focal-right-fill size-3 shrink-0 text-text-tertiary opacity-0 transition-[opacity,transform] duration-150 group-focus-within/feeds-header:opacity-100 group-hover/feeds-header:opacity-100",
            isOpen && "rotate-90",
          )}
        />
      </button>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/feeds-header:opacity-100 group-hover/feeds-header:opacity-100">
        <ActionButton
          tooltip={t("sidebar.feed_column.create_group_button")}
          onClick={(event) => {
            event.stopPropagation()
            presentCategoryCreationModal(view)
          }}
        >
          <i className="i-focal-add size-4 text-text-secondary" />
        </ActionButton>
        <SortButton />
      </div>
    </div>
  )
}
