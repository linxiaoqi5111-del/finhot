import { Skeleton } from "@follow/components/ui/skeleton/index.jsx"

import { ListItem } from "~/modules/entry-column/templates/list-item-template"

import { readableContentMaxWidth } from "../styles"
import type { UniversalItemProps } from "../types"

export function AudioItem({ entryId, translation }: UniversalItemProps) {
  return <ListItem entryId={entryId} translation={translation} />
}

AudioItem.wrapperClassName = readableContentMaxWidth

export const AudioItemSkeleton = (
  <div className={`relative mx-auto w-full select-none rounded-md ${readableContentMaxWidth}`}>
    <div className="relative">
      <div className="group relative flex py-4">
        <Skeleton className="mr-2 size-5 rounded-sm" />
        <div className="-mt-0.5 min-w-0 flex-1 text-sm leading-tight">
          <div className="flex items-center justify-between gap-2 text-[10px] font-bold text-material-opaque">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-10 shrink-0" />
          </div>
          <div className="relative my-0.5 break-words font-medium">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-3/4" />
          </div>
        </div>
      </div>
    </div>
  </div>
)
