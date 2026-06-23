import { EllipsisHorizontalTextWithTooltip } from "@follow/components/ui/typography/index.js"
import { useCollectionEntry, useIsEntryStarred } from "@follow/store/collection/hooks"
import { useEntry } from "@follow/store/entry/hooks"
import type { EntryModel } from "@follow/store/entry/types"
import { useFeedById } from "@follow/store/feed/hooks"
import { useInboxById } from "@follow/store/inbox/hooks"
import { cn } from "@follow/utils/utils"
import { useMemo } from "react"
import { titleCase } from "title-case"

import { useGeneralSettingKey } from "~/atoms/settings/general"
import { RelativeTime } from "~/components/ui/datetime"
import { FEED_COLLECTION_LIST } from "~/constants"
import { useEntryIsRead } from "~/hooks/biz/useAsRead"
import { useRouteParamsSelector } from "~/hooks/biz/useRouteParams"
import { isVirtualTimelineScopeFeedId } from "~/lib/timeline-scope"
import { EntryTranslation } from "~/modules/entry-column/translation"
import type { FeedIconEntry } from "~/modules/feed/feed-icon"
import { FeedIcon } from "~/modules/feed/feed-icon"
import { FeedTitle } from "~/modules/feed/feed-title"
import { getPreferredTitle } from "~/store/feed/hooks"

import { EntryAiTagChips } from "../components/EntryAiTagChips"
import { EntryClusterBadge } from "../components/EntryClusterBadge"
import { EntryQualityScoreBadge } from "../components/EntryQualityScoreBadge"
import { useEntrySummaryDescription } from "../hooks/useEntrySummaryDescription"
import { StarIcon } from "../star-icon"
import type { UniversalItemProps } from "../types"
import { getListItemLineClampClassNames } from "./list-item-line-clamp"

/**
 * Card-based entry item with AIHOT-inspired visual hierarchy:
 * - Source + time header row
 * - Bold title
 * - Summary description
 * - Tags + score badge footer
 */

const entrySelector = (state: EntryModel) => {
  /// keep-sorted
  const { authorAvatar, authorUrl, description, feedId, inboxHandle, publishedAt, title } = state

  const photo = state.media?.find((a) => a.type === "photo")
  const firstPhotoUrl = photo?.url

  /// keep-sorted
  return {
    authorAvatar,
    authorUrl,
    description,
    feedId,
    firstPhotoUrl,
    inboxId: inboxHandle,
    publishedAt,
    title,
  }
}

export function ListItem({
  entryId,
  translation,
  simple,
}: UniversalItemProps & {
  simple?: boolean
}) {
  const entry = useEntry(entryId, entrySelector)
  const { description: displayDescription, isSummary } = useEntrySummaryDescription(
    entryId,
    entry?.description,
  )

  const isInCollection = useIsEntryStarred(entryId)
  const collectionCreatedAt = useCollectionEntry(entryId)?.createdAt

  const isRead = useEntryIsRead(entryId)

  const inInCollection = useRouteParamsSelector((s) => s.feedId === FEED_COLLECTION_LIST)

  // Show the feed icon (left avatar) only when viewing aggregated/group contexts.
  // In a single specific feed, the icon is redundant since the user is already inside that feed.
  const showFeedIcon = useRouteParamsSelector(
    ({ feedId, folderName, isCollection, isAllFeeds, inboxId, listId }) => {
      if (!feedId) return true
      return (
        isVirtualTimelineScopeFeedId(feedId) ||
        !!folderName ||
        isCollection ||
        isAllFeeds ||
        !!inboxId ||
        !!listId
      )
    },
  )

  const feed = useFeedById(entry?.feedId, (feed) => {
    return {
      type: feed.type,
      ownerUserId: feed.ownerUserId,
      id: feed.id,
      title: feed.title,
      url: (feed as any).url || "",
      image: feed.image,
      siteUrl: feed.siteUrl,
    }
  })

  const inbox = useInboxById(entry?.inboxId)

  const bilingual = useGeneralSettingKey("translationMode") === "bilingual"

  const iconEntry: FeedIconEntry = useMemo(
    () => ({
      firstPhotoUrl: entry?.firstPhotoUrl,
      authorAvatar: entry?.authorAvatar,
    }),
    [entry?.firstPhotoUrl, entry?.authorAvatar],
  )

  const titleEntry = useMemo(
    () => ({
      authorUrl: entry?.authorUrl,
    }),
    [entry?.authorUrl],
  )

  const lineClamp = useMemo(
    () =>
      getListItemLineClampClassNames({
        bilingual,
        entryDescription: entry?.description,
        entryTitle: entry?.title,
        isSummary,
        simple,
        translationDescription: translation?.description,
      }),
    [bilingual, entry?.description, entry?.title, isSummary, simple, translation?.description],
  )

  const dimRead = useGeneralSettingKey("dimRead")
  // NOTE: prevent 0 height element, react virtuoso will not stop render any more
  if (!entry || !(feed || inbox)) return null

  const displayTime = inInCollection ? collectionCreatedAt : entry?.publishedAt

  const related = feed || inbox

  return (
    <div
      className={cn(
        "group relative mx-2 my-1.5 rounded-xl border border-border/60 bg-fill-quaternary/50 px-4 py-3 transition-colors",
        !isRead && "border-l-2 border-l-accent",
        isRead && dimRead && "opacity-75",
      )}
    >
      {/* Header: source icon + name + time + score */}
      <div className="flex items-center gap-2">
        {showFeedIcon && <FeedIcon target={related} fallback entry={iconEntry} size={18} />}
        <EllipsisHorizontalTextWithTooltip
          className={cn("min-w-0 flex-1 truncate text-[11px] font-semibold", "text-text-secondary")}
        >
          <FeedTitle
            feed={related}
            title={getPreferredTitle(related, titleEntry)}
            className="space-x-0.5"
          />
        </EllipsisHorizontalTextWithTooltip>
        {!!displayTime && (
          <span className="shrink-0 text-[11px] text-text-tertiary">
            <RelativeTime date={displayTime} />
          </span>
        )}
        <EntryQualityScoreBadge entryId={entryId} />
      </div>

      {/* Title */}
      <div className={cn("mt-1.5 min-w-0", lineClamp.global)}>
        <div
          className={cn(
            "relative break-words text-[14px] font-semibold leading-snug",
            "text-text",
            !!isInCollection && "pr-5",
          )}
        >
          {entry?.title ? (
            <EntryTranslation
              className={cn("autospace-normal hyphens-auto", lineClamp.title)}
              source={titleCase(entry?.title ?? "")}
              target={titleCase(translation?.title ?? "")}
            />
          ) : (
            <EntryTranslation
              className={cn("autospace-normal hyphens-auto", lineClamp.description)}
              source={displayDescription}
              target={isSummary ? undefined : translation?.description}
            />
          )}
          {!!isInCollection && <StarIcon className="absolute right-0 top-0" />}
        </div>
      </div>

      {/* Description / Summary */}
      {!simple && displayDescription && entry?.title && (
        <div
          className={cn(
            "mt-1 text-[12px] leading-relaxed",
            "text-text-secondary",
            lineClamp.global,
          )}
        >
          <EntryTranslation
            className={cn("autospace-normal line-clamp-2 hyphens-auto")}
            source={displayDescription}
            target={isSummary ? undefined : translation?.description}
          />
        </div>
      )}

      {/* Footer: tags + cluster badge */}
      <div className="mt-1.5 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <EntryAiTagChips entryId={entryId} />
        </div>
        <EntryClusterBadge entryId={entryId} />
      </div>
    </div>
  )
}
