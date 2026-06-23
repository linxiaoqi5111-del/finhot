import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@follow/components/ui/hover-card/index.js"
import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import type { EntryQualityScoreRecord } from "@follow/shared/entry-quality-score"
import { getQualityScoreTier } from "@follow/shared/entry-quality-score"
import { useEntryQualityScore } from "@follow/store/entry-quality-score/hooks"
import { cn } from "@follow/utils/utils"
import { useMemo } from "react"
import { useTranslation } from "react-i18next"

import { useGeneralSettingKey } from "~/atoms/settings/general"

const tierClassName: Record<ReturnType<typeof getQualityScoreTier>, string> = {
  high: "bg-green/20 text-green border border-green/30",
  medium: "bg-yellow/15 text-yellow border border-yellow/20",
  low: "bg-gray/15 text-text-secondary border border-gray/15",
  ignore: "bg-gray/10 text-text-tertiary border border-gray/10",
}

const DIMENSION_KEYS = [
  "information_gain",
  "depth",
  "evidence",
  "actionability",
  "originality",
  "signal_density",
] as const satisfies readonly (keyof EntryQualityScoreRecord["scores"])[]

const qualityScoreHoverCardStyle = {
  backgroundColor: "rgb(var(--color-materialOpaque))",
  boxShadow:
    "0 6px 20px rgba(0, 0, 0, 0.08), 0 4px 12px rgba(0, 0, 0, 0.05), 0 2px 6px rgba(0, 0, 0, 0.04)",
} as const

const QualityScoreMvpDetails = ({ record }: { record: EntryQualityScoreRecord }) => {
  const { t } = useTranslation("app")

  const contentTypes = useMemo(
    () =>
      Object.entries(record.content_types)
        .filter(([, weight]) => typeof weight === "number" && weight > 0)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3),
    [record.content_types],
  )

  return (
    <div className="flex flex-col gap-2 text-xs leading-snug text-text">
      <div className="font-semibold">
        {t("entry.quality_score.mvp.title", { score: record.quality_score })}
      </div>

      <div className="text-text-secondary">
        {t("entry.quality_score.mvp.confidence", {
          value: Math.round(record.confidence * 100),
        })}
      </div>

      {record.summary ? <p>{record.summary}</p> : null}

      {contentTypes.length > 0 ? (
        <div>
          <div className="mb-1 font-medium text-text-secondary">
            {t("entry.quality_score.mvp.content_types")}
          </div>
          <ul className="space-y-0.5">
            {contentTypes.map(([type, weight]) => (
              <li key={type}>
                {type} ({Math.round(weight * 100)}%)
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <div className="mb-1 font-medium text-text-secondary">
          {t("entry.quality_score.mvp.dimensions")}
        </div>
        <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5">
          {DIMENSION_KEYS.map((key) => (
            <li key={key}>
              {key}: {record.scores[key]}/5
            </li>
          ))}
        </ul>
      </div>

      {record.positive_reasons.length > 0 ? (
        <div>
          <div className="mb-1 font-medium text-green">{t("entry.quality_score.mvp.positive")}</div>
          <ul className="list-disc space-y-0.5 pl-4">
            {record.positive_reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {record.negative_reasons.length > 0 ? (
        <div>
          <div className="mb-1 font-medium text-orange">
            {t("entry.quality_score.mvp.negative")}
          </div>
          <ul className="list-disc space-y-0.5 pl-4">
            {record.negative_reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

export const EntryQualityScoreBadge = ({ entryId }: { entryId: string }) => {
  const qualityScoreEnabled = useGeneralSettingKey("qualityScore")
  const record = useEntryQualityScore(entryId)

  if (!LOCAL_RSS_MODE || !qualityScoreEnabled || !record) return null

  const tier = getQualityScoreTier(record.quality_score)

  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        <span
          className={cn(
            "inline-flex min-w-[2rem] shrink-0 cursor-default items-center justify-center rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
            tierClassName[tier],
          )}
        >
          {record.quality_score}
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={12}
        collisionPadding={16}
        style={qualityScoreHoverCardStyle}
        className={cn(
          "w-80 rounded-xl border border-border p-3",
          "!bg-material-opaque !backdrop-blur-none",
        )}
      >
        <QualityScoreMvpDetails record={record} />
      </HoverCardContent>
    </HoverCard>
  )
}
