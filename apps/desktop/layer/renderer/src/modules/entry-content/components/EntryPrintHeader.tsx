import { useEntry } from "@follow/store/entry/hooks"
import { useFeedById } from "@follow/store/feed/hooks"
import { useInboxById } from "@follow/store/inbox/hooks"
import { cn } from "@follow/utils/utils"

import { readableContentMaxWidthClassName } from "~/constants/ui"
import { FocalLogo, FocalWordmark } from "~/modules/brand/FocalLogo"

const PRINT_HOMEPAGE_LABEL = "FinHot"

export const EntryPrintHeader = ({ entryId }: { entryId: string }) => {
  const entry = useEntry(entryId, (state) => ({
    feedId: state.feedId,
    inboxId: state.inboxHandle,
  }))

  const feed = useFeedById(entry?.feedId)
  const inbox = useInboxById(entry?.inboxId)
  const sourceTitle = feed?.title || inbox?.title

  return (
    <div className={cn("hidden print:block", readableContentMaxWidthClassName, "mx-auto px-4")}>
      <div className="mb-8 border-b border-border pb-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <FocalLogo className="size-4 shrink-0 rounded" />
            <FocalWordmark className="text-sm" />
          </div>

          <span className="text-xs font-medium text-text-secondary">{PRINT_HOMEPAGE_LABEL}</span>
        </div>

        <div className="mt-3 space-y-1.5">
          <p className="text-sm font-medium text-text-secondary">
            Local-first RSS reader with BYOK AI
          </p>
          {sourceTitle ? (
            <p className="text-sm text-text-secondary">Source: {sourceTitle}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
