import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { useEntryAiTags, useEntryContentType } from "@follow/store/entry-tags/hooks"

const chipClassName = "rounded bg-fill-secondary px-1.5 py-0.5 text-[10px] text-text-secondary"

export const EntryAiTagChips = ({ entryId }: { entryId: string }) => {
  const tags = useEntryAiTags(entryId)
  const contentType = useEntryContentType(entryId)

  if (!LOCAL_RSS_MODE) return null
  if (!tags?.length && !contentType) return null

  return (
    <div className="my-0.5 flex flex-wrap gap-1">
      {contentType ? <span className={chipClassName}>{contentType.label}</span> : null}
      {tags?.map((tag) => (
        <span key={tag.label} className={chipClassName}>
          {tag.label}
        </span>
      ))}
    </div>
  )
}
