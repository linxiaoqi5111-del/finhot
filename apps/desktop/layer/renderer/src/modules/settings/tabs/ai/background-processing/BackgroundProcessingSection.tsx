import { Button } from "@follow/components/ui/button/index.js"
import { Label } from "@follow/components/ui/label/index.jsx"
import {
  useByokProcessingBusy,
  useEmbeddingJobStatus,
  useEmbeddingProcessingBusy,
  useEnrichmentStatus,
  useSummaryGeneratingCount,
} from "@follow/store/enrichment/hooks"
import { entryEnrichmentService } from "@follow/store/enrichment/service"
import type { EnrichmentPhase } from "@follow/store/enrichment/types"
import { getEntry } from "@follow/store/entry/getter"
import { useEmbeddingCoverageStats } from "@follow/store/entry-embedding/hooks"
import { entryEmbeddingJobService } from "@follow/store/entry-embedding/job-service"
import { useQualityScoreCoverageStats } from "@follow/store/entry-quality-score/hooks"
import { cn } from "@follow/utils/utils"
import type { ReactNode } from "react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { getActionLanguage, useGeneralSettingKey } from "~/atoms/settings/general"
import { useModalStack } from "~/components/ui/modal/stacked/hooks"

import { RescoreFeedsModalContent } from "./RescoreFeedsModal"

const formatRelativeUpdatedAt = (iso: string) => {
  const deltaMs = Date.now() - new Date(iso).getTime()
  if (deltaMs < 5_000) return "just_now"

  const seconds = Math.floor(deltaMs / 1000)
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  return `${minutes}m`
}

const useByokPhaseLabel = () => {
  const { t } = useTranslation("ai")

  return (phase: EnrichmentPhase | null) => {
    switch (phase) {
      case "summary": {
        return t("byok_processing.phase.summary")
      }
      case "titleTranslation": {
        return t("byok_processing.phase.title_translation")
      }
      case "tags": {
        return t("byok_processing.phase.tags")
      }
      case "qualityScore": {
        return t("byok_processing.phase.quality_score")
      }
      default: {
        return t("byok_processing.phase.pending")
      }
    }
  }
}

const ProcessingSectionShell = ({ children }: { children: ReactNode }) => (
  <section className="mt-6 min-w-0">{children}</section>
)

const ProcessingSectionHeader = ({
  title,
  description,
}: {
  title: string
  description: string
}) => (
  <div className="space-y-1">
    <Label className="text-sm font-medium text-text">{title}</Label>
    <p className="text-xs leading-relaxed text-text-secondary">{description}</p>
  </div>
)

const ProcessingPanel = ({
  namespace,
  title,
  description,
  idleHint,
  isBusy,
  relativeUpdatedAt,
  activeJobs,
  lastError,
  renderActiveJob,
  summaryGeneratingCount,
  stats,
  footer,
}: {
  namespace: "byok_processing" | "embedding_processing"
  title: string
  description: string
  idleHint: string
  isBusy: boolean
  relativeUpdatedAt: string
  activeJobs: Array<{ entryId: string }>
  lastError: { entryId: string; message: string } | null
  renderActiveJob: (entryId: string) => ReactNode
  summaryGeneratingCount?: number
  stats: ReactNode
  footer?: ReactNode
}) => {
  const { t } = useTranslation("ai")

  return (
    <ProcessingSectionShell>
      <div className="min-w-0 space-y-3">
        <ProcessingSectionHeader title={title} description={description} />

        <div className="min-w-0 overflow-hidden rounded-lg border border-fill-secondary p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "inline-flex size-2.5 rounded-full",
                  isBusy ? "animate-pulse bg-blue" : "bg-green",
                )}
              />
              <span className="text-sm font-medium text-text">
                {isBusy ? t(`${namespace}.status.processing`) : t(`${namespace}.status.idle`)}
              </span>
            </div>
            <span className="text-xs text-text-tertiary">
              {relativeUpdatedAt === "just_now"
                ? t(`${namespace}.updated.just_now`)
                : t(`${namespace}.updated.ago`, { duration: relativeUpdatedAt })}
            </span>
          </div>

          <div className="mt-4">{stats}</div>

          {activeJobs.length > 0 ? (
            <div className="mt-4 min-w-0 space-y-2">
              <div className="text-xs font-medium text-text-secondary">
                {t(`${namespace}.active_jobs`)}
              </div>
              {activeJobs.map((job) => (
                <div key={job.entryId} className="min-w-0 overflow-hidden">
                  {renderActiveJob(job.entryId)}
                </div>
              ))}
            </div>
          ) : null}

          {summaryGeneratingCount && summaryGeneratingCount > 0 && activeJobs.length === 0 ? (
            <div className="mt-4 text-xs text-text-secondary">
              {t("byok_processing.summary_generating", { count: summaryGeneratingCount })}
            </div>
          ) : null}

          {lastError ? (
            <div className="mt-4 rounded-md border border-red/20 bg-red/10 px-3 py-2 text-xs text-red">
              <div className="font-medium">{t(`${namespace}.last_error`)}</div>
              <div className="mt-1 break-all text-text-secondary">{lastError.entryId}</div>
              <div className="mt-1">{lastError.message}</div>
            </div>
          ) : null}

          {footer}

          {!isBusy ? (
            <p className="mt-4 text-xs leading-relaxed text-text-tertiary">{idleHint}</p>
          ) : null}
        </div>
      </div>
    </ProcessingSectionShell>
  )
}

const ByokActiveJobRow = ({
  entryId,
  phase,
}: {
  entryId: string
  phase: EnrichmentPhase | null
}) => {
  const entry = getEntry(entryId)
  const title = entry?.title?.trim() || entryId
  const getPhaseLabel = useByokPhaseLabel()

  return (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 overflow-hidden rounded-md bg-fill-secondary/70 px-3 py-2">
      <div className="min-w-0 overflow-hidden">
        <div className="truncate text-sm font-medium text-text" title={title}>
          {title}
        </div>
        <div className="truncate text-xs text-text-tertiary" title={entryId}>
          {entryId}
        </div>
      </div>
      <div className="shrink-0 text-xs font-medium text-blue">{getPhaseLabel(phase)}</div>
    </div>
  )
}

const EmbeddingActiveJobRow = ({ entryId }: { entryId: string }) => {
  const { t } = useTranslation("ai")
  const entry = getEntry(entryId)
  const title = entry?.title?.trim() || entryId

  return (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 overflow-hidden rounded-md bg-fill-secondary/70 px-3 py-2">
      <div className="min-w-0 overflow-hidden">
        <div className="truncate text-sm font-medium text-text" title={title}>
          {title}
        </div>
        <div className="truncate text-xs text-text-tertiary" title={entryId}>
          {entryId}
        </div>
      </div>
      <div className="shrink-0 text-xs font-medium text-blue">
        {t("embedding_processing.phase.embedding")}
      </div>
    </div>
  )
}

export const ByokProcessingSection = () => {
  const { t } = useTranslation("ai")
  const { present } = useModalStack()
  const status = useEnrichmentStatus()
  const summaryGeneratingCount = useSummaryGeneratingCount()
  const isBusy = useByokProcessingBusy()
  const qualityScoreCoverage = useQualityScoreCoverageStats()
  const qualityScoreEnabled = useGeneralSettingKey("qualityScore")
  const [isRescoring, setIsRescoring] = useState(false)

  const handleRescoreAll = async () => {
    if (qualityScoreCoverage.eligibleCount === 0) {
      toast.message(t("byok_processing.rescore.empty"))
      return
    }

    const confirmed = window.confirm(t("byok_processing.rescore.confirm"))
    if (!confirmed) return

    setIsRescoring(true)
    try {
      const count = await entryEnrichmentService.rescoreAll({
        actionLanguage: getActionLanguage(),
      })
      toast.success(t("byok_processing.rescore.started", { count }))
    } catch (error) {
      console.warn("[quality-score] Rescore failed:", error)
      toast.error(t("byok_processing.rescore.failed"))
    } finally {
      setIsRescoring(false)
    }
  }

  return (
    <ProcessingPanel
      namespace="byok_processing"
      title={t("byok_processing.title")}
      description={t("byok_processing.description")}
      idleHint={t("byok_processing.idle_hint")}
      isBusy={isBusy}
      relativeUpdatedAt={formatRelativeUpdatedAt(status.updatedAt)}
      activeJobs={status.activeJobs}
      lastError={status.lastError}
      summaryGeneratingCount={summaryGeneratingCount}
      stats={
        <div
          className={cn(
            "grid gap-3",
            qualityScoreEnabled ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3",
          )}
        >
          <StatCard label={t("byok_processing.stats.queue")} value={status.queueLength} />
          <StatCard label={t("byok_processing.stats.pending")} value={status.pendingCount} />
          <StatCard
            label={t("byok_processing.stats.active")}
            value={status.activeJobs.length + summaryGeneratingCount}
          />
          {qualityScoreEnabled ? (
            <StatCard
              label={t("byok_processing.stats.scored")}
              value={qualityScoreCoverage.coveredCount}
              suffix={
                qualityScoreCoverage.eligibleCount > 0
                  ? ` / ${qualityScoreCoverage.eligibleCount}`
                  : undefined
              }
            />
          ) : null}
        </div>
      }
      footer={
        qualityScoreEnabled ? (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={isBusy || isRescoring || qualityScoreCoverage.eligibleCount === 0}
                onClick={() => void handleRescoreAll()}
              >
                {isRescoring
                  ? t("byok_processing.rescore.running")
                  : t("byok_processing.rescore.action")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={isBusy || isRescoring}
                onClick={() => {
                  present({
                    title: t("byok_processing.rescore_feeds.title"),
                    content: ({ dismiss }) => <RescoreFeedsModalContent onSuccess={dismiss} />,
                  })
                }}
              >
                {t("byok_processing.rescore_feeds.open")}
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-text-tertiary">
              {t("byok_processing.rescore.hint")}
            </p>
          </div>
        ) : null
      }
      renderActiveJob={(entryId) => {
        const job = status.activeJobs.find((item) => item.entryId === entryId)
        return <ByokActiveJobRow entryId={entryId} phase={job?.phase ?? null} />
      }}
    />
  )
}

export const EmbeddingProcessingSection = () => {
  const { t } = useTranslation("ai")
  const status = useEmbeddingJobStatus()
  const coverage = useEmbeddingCoverageStats()
  const isBusy = useEmbeddingProcessingBusy()
  const [isRebuilding, setIsRebuilding] = useState(false)

  const handleRebuild = async () => {
    if (coverage.eligibleCount === 0) {
      toast.message(t("embedding_processing.rebuild.empty"))
      return
    }

    const confirmed = window.confirm(t("embedding_processing.rebuild.confirm"))
    if (!confirmed) return

    setIsRebuilding(true)
    try {
      const count = await entryEmbeddingJobService.rebuildAll()
      toast.success(t("embedding_processing.rebuild.started", { count }))
    } catch (error) {
      console.warn("[embedding] Rebuild failed:", error)
      toast.error(t("embedding_processing.rebuild.failed"))
    } finally {
      setIsRebuilding(false)
    }
  }

  return (
    <ProcessingPanel
      namespace="embedding_processing"
      title={t("embedding_processing.title")}
      description={t("embedding_processing.description")}
      idleHint={t("embedding_processing.idle_hint")}
      isBusy={isBusy}
      relativeUpdatedAt={formatRelativeUpdatedAt(status.updatedAt)}
      activeJobs={status.activeJobs}
      lastError={status.lastError}
      stats={
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label={t("embedding_processing.stats.queue")} value={status.queueLength} />
          <StatCard
            label={t("embedding_processing.stats.active")}
            value={status.activeJobs.length}
          />
          <StatCard label={t("embedding_processing.stats.backlog")} value={coverage.backlogCount} />
          <StatCard
            label={t("embedding_processing.stats.covered")}
            value={coverage.coveredCount}
            suffix={coverage.eligibleCount > 0 ? ` / ${coverage.eligibleCount}` : undefined}
          />
        </div>
      }
      footer={
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={isBusy || isRebuilding || coverage.eligibleCount === 0}
            onClick={() => void handleRebuild()}
          >
            {isRebuilding
              ? t("embedding_processing.rebuild.running")
              : t("embedding_processing.rebuild.action")}
          </Button>
          <p className="text-xs leading-relaxed text-text-tertiary">
            {t("embedding_processing.rebuild.hint")}
          </p>
        </div>
      }
      renderActiveJob={(entryId) => <EmbeddingActiveJobRow entryId={entryId} />}
    />
  )
}

/** @deprecated Use ByokProcessingSection or EmbeddingProcessingSection instead. */
export const BackgroundProcessingSection = ByokProcessingSection

const StatCard = ({ label, value, suffix }: { label: string; value: number; suffix?: string }) => (
  <div className="min-w-0 overflow-hidden rounded-md bg-fill-secondary/60 px-3 py-2">
    <div className="truncate text-lg font-semibold tabular-nums text-text">
      {value}
      {suffix ? <span className="text-sm font-normal text-text-tertiary">{suffix}</span> : null}
    </div>
    <div className="truncate text-xs text-text-secondary">{label}</div>
  </div>
)
