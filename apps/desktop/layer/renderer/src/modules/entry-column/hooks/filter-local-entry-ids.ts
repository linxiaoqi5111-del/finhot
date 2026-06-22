const URL_RE = /^https?:\/\//i

function isLowQualityEntry(entry: {
  title?: string | null
  url?: string | null
  content?: string | null
  description?: string | null
}): boolean {
  const title = (entry.title ?? "").trim()
  const body = [entry.content ?? "", entry.description ?? ""]
    .join(" ")
    .replaceAll(/\s+/g, " ")
    .trim()

  if (!title && body.length < 10) return true
  if (URL_RE.test(title) && body.length < 30) return true
  if (entry.url && title === entry.url && body.length < 30) return true
  if (entry.url && body === entry.url) return true

  return false
}

type LocalEntryVisibility = {
  id: string
  read?: boolean | null
  title?: string | null
  url?: string | null
  content?: string | null
  description?: string | null
}

export const getVisibleLocalEntryIds = <TEntry extends LocalEntryVisibility>({
  sourceIds,
  entries,
  stickyVisibleIds,
  unreadOnly,
}: {
  sourceIds: string[]
  entries: Record<string, TEntry | null | undefined>
  stickyVisibleIds?: ReadonlySet<string>
  unreadOnly: boolean
}) => {
  return sourceIds.filter((id) => {
    const entry = entries[id]

    if (!entry) return false
    if (unreadOnly && !!entry.read && !stickyVisibleIds?.has(entry.id)) {
      return false
    }
    if (isLowQualityEntry(entry)) return false

    return true
  })
}
