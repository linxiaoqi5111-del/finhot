import { ScrollArea } from "@follow/components/ui/scroll-area/index.js"
import { EllipsisHorizontalTextWithTooltip } from "@follow/components/ui/typography/EllipsisWithTooltip.js"
import { FeedViewType } from "@follow/constants"
import { getEntry, getEntryIdsByFeedId } from "@follow/store/entry/getter"
import { cn } from "@follow/utils/utils"
import { useForceUpdate } from "motion/react"
import { useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu/dropdown-menu"
import { useNavigateEntry } from "~/hooks/biz/useNavigateEntry"
import { useShowEntryDetailsColumn } from "~/hooks/biz/useShowEntryDetailsColumn"

import { useEntryTitleMeta } from "../../../atoms"
import { useEntryHeaderContext } from "./context"

const Slash = <i className="i-focal-line size-4 shrink-0 rotate-[-25deg] text-text-tertiary" />

function FeedEntriesDropdown({
  feedId,
  currentEntryId,
  onNavigate,
}: {
  feedId: string
  currentEntryId: string
  onNavigate: ReturnType<typeof useNavigateEntry>
}) {
  const { t } = useTranslation()
  const siblingEntriesRef = useRef<{ id: string; title: string }[]>([])
  const [forceUpdate] = useForceUpdate()

  const handleRefreshDropDownData = useCallback(
    (open: boolean) => {
      if (!open) return

      const entryIds = getEntryIdsByFeedId(feedId)
      if (!entryIds) return

      siblingEntriesRef.current = []
      for (const entryId of entryIds) {
        const entry = getEntry(entryId)
        if (!entry) continue
        const { title } = entry
        if (!title) continue
        siblingEntriesRef.current.push({ id: entryId, title })
      }

      forceUpdate()
    },
    [feedId, forceUpdate],
  )

  const entryIds = getEntryIdsByFeedId(feedId)
  if (!entryIds || entryIds.length <= 1) return null

  return (
    <DropdownMenu onOpenChange={handleRefreshDropDownData}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="no-drag-region -ml-2 inline-flex size-6 items-center justify-center rounded text-text-tertiary transition-colors hover:text-text focus-visible:bg-fill/60"
          aria-label={t("entry_content.open_entries_from_feed")}
        >
          <i className="i-focal-down size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="p-0">
        <ScrollArea.ScrollArea
          rootClassName="max-h-[60vh] min-w-64"
          viewportClassName="max-h-[60vh]"
        >
          <div className="p-1">
            {siblingEntriesRef.current.map((e) => (
              <DropdownMenuItem
                key={e.id}
                onClick={() => onNavigate({ entryId: e.id })}
                checked={e.id === currentEntryId}
              >
                <span className="truncate" title={e.title}>
                  {e.title}
                </span>
              </DropdownMenuItem>
            ))}
          </div>
        </ScrollArea.ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function EntryHeaderBreadcrumb() {
  const { t } = useTranslation(["app", "common"])
  const meta = useEntryTitleMeta()

  const navigate = useNavigateEntry()
  const { entryId } = useEntryHeaderContext()

  const showEntryDetailsColumn = useShowEntryDetailsColumn()
  if (showEntryDetailsColumn && meta?.entryTitle) {
    return (
      <EllipsisHorizontalTextWithTooltip className="min-w-0 truncate px-1.5 py-0.5 text-lg font-bold leading-tight text-text opacity-0 transition-opacity duration-200 group-data-[at-top=false]/header:opacity-100">
        {meta.entryTitle}
      </EllipsisHorizontalTextWithTooltip>
    )
  }
  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">
      <nav
        aria-label={t("common:a11y.breadcrumb") as string}
        className={
          "group/breadcrumb flex min-w-0 items-center gap-1 truncate leading-tight text-text-secondary"
        }
      >
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            aria-label={t("entry.exit_detail")}
            className="no-drag-region inline-flex shrink-0 items-center rounded-full bg-transparent p-2 text-text-secondary hover:bg-fill/50 hover:text-text focus-visible:bg-fill/60"
            onClick={() => navigate({ entryId: null, view: FeedViewType.All })}
          >
            <i className="i-focal-close size-5" />
          </button>
          {meta && (
            <>
              <div className="hidden min-w-0 shrink items-center @[700px]:flex">
                <button
                  type="button"
                  className={cn(
                    "no-drag-region inline-flex max-w-[40vw] items-center truncate rounded bg-transparent px-1.5 py-0.5 text-sm text-text-secondary transition-colors hover:bg-fill/50 hover:text-text focus-visible:bg-fill/60",
                  )}
                  onClick={() =>
                    navigate({ entryId: null, feedId: meta.feedId, view: FeedViewType.All })
                  }
                  title={meta.feedTitle}
                >
                  <span className="truncate">{meta.feedTitle}</span>
                </button>

                <FeedEntriesDropdown
                  feedId={meta.feedId}
                  currentEntryId={entryId}
                  onNavigate={navigate}
                />
              </div>

              {!!meta.entryTitle && (
                <>
                  <span className="hidden shrink-0 @[700px]:inline">{Slash}</span>
                  <span
                    className="min-w-0 max-w-[30vw] truncate px-1.5 py-0.5 text-sm text-text"
                    title={meta.entryTitle}
                  >
                    {meta.entryTitle}
                  </span>
                </>
              )}
            </>
          )}
        </div>
      </nav>
    </div>
  )
}
