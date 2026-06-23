import { ListItem } from "~/modules/entry-column/templates/list-item-template"

import type { UniversalItemProps } from "../types"

export {
  ArticleItemSkeleton as AllItemSkeleton,
  ArticleItemStateLess as AllItemStateLess,
} from "./article-item"

export function AllItem({ entryId, translation }: UniversalItemProps) {
  return <ListItem entryId={entryId} translation={translation} />
}

AllItem.wrapperClassName = "pl-5 pr-4 @[700px]:pl-6 @[1024px]:pr-5"
