import { isSafari } from "@follow/utils/utils"

interface GetListItemLineClampClassNamesOptions {
  bilingual: boolean
  entryDescription?: string | null
  entryTitle?: string | null
  isSummary: boolean
  simple?: boolean
  translationDescription?: string | null
}

export const getListItemLineClampClassNames = ({
  bilingual,
  entryDescription,
  entryTitle,
  isSummary,
  simple,
  translationDescription,
}: GetListItemLineClampClassNamesOptions) => {
  const envIsSafari = isSafari()
  const lineClampTitle = 2
  let lineClampDescription = 2

  if (
    translationDescription &&
    translationDescription !== entryDescription &&
    !isSummary &&
    !simple &&
    bilingual
  ) {
    lineClampDescription += 1
  }

  const hasTitle = !!entryTitle
  const globalLineClamp = simple
    ? lineClampTitle
    : hasTitle
      ? lineClampTitle + lineClampDescription
      : lineClampDescription

  return {
    global: !envIsSafari ? `line-clamp-[${globalLineClamp}]` : "",
    title: `line-clamp-${lineClampTitle}`,
    description: envIsSafari ? `line-clamp-[${lineClampDescription}]` : "",
  }
}
