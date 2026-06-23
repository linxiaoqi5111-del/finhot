import { Skeleton } from "@follow/components/ui/skeleton/index.jsx"
import { cn } from "@follow/utils/utils"

import { RelativeTime } from "~/components/ui/datetime"
import { ListItem } from "~/modules/entry-column/templates/list-item-template"
import { FeedIcon } from "~/modules/feed/feed-icon"
import { FeedTitle } from "~/modules/feed/feed-title"

import { readableContentMaxWidth } from "../styles"
import type { EntryItemStatelessProps, UniversalItemProps } from "../types"

export function ArticleItem({ entryId, translation }: UniversalItemProps) {
  return <ListItem entryId={entryId} translation={translation} />
}

ArticleItem.wrapperClassName = cn(readableContentMaxWidth, "pl-4 pr-3")

export function ArticleItemStateLess({ entry, feed }: EntryItemStatelessProps) {
  return (
    <div className="group relative flex py-4">
      <FeedIcon target={feed} fallback className="mr-2 size-5" />
      <div className="-mt-0.5 min-w-0 flex-1 text-sm leading-tight">
        <div className="flex items-center justify-between gap-2 text-[10px] font-bold text-text-secondary">
          <FeedTitle feed={feed} className="min-w-0 flex-1 truncate" />
          {!!entry.publishedAt && (
            <span className="shrink-0">
              <RelativeTime date={entry.publishedAt} />
            </span>
          )}
        </div>
        <div className="relative my-0.5 truncate break-words font-medium text-text">
          {entry.title}
        </div>
        <div className="truncate text-[13px] text-text-secondary">{entry.description}</div>
      </div>
    </div>
  )
}

export const ArticleItemSkeleton = (
  <div className={`relative rounded-md ${readableContentMaxWidth}`}>
    <div className="relative">
      <div className="group relative flex py-4">
        <Skeleton className="mr-2 size-5 rounded-sm" />
        <div className="-mt-0.5 min-w-0 flex-1 text-sm leading-tight">
          <div className="flex items-center justify-between gap-2 text-[10px] font-bold text-material-opaque">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16 shrink-0" />
          </div>
          <div className="relative my-1 break-words font-medium">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="mt-1 h-3.5 w-3/4" />
          </div>
          <div className="mt-1.5 text-[13px] text-material-opaque">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="mt-1 h-3 w-4/5" />
          </div>
        </div>
      </div>
    </div>
  </div>
)
