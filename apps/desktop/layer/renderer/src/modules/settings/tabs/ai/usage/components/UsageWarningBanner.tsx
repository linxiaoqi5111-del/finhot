import { cn } from "@follow/utils/utils"
import { useTranslation } from "react-i18next"

type WarningLevel = "safe" | "moderate" | "high" | "critical" | (string & {})

export interface UsageWarningBannerProps {
  level: WarningLevel
  projectedLimitTime?: number | null
  usageRate?: number
  detailed?: boolean
  className?: string
}

export const UsageWarningBanner = ({
  level,
  projectedLimitTime,
  usageRate,
  detailed,
  className,
}: UsageWarningBannerProps) => {
  const { t } = useTranslation("ai")

  if (!level || level === "safe") return null

  const stylesByLevel: Record<string, string> = {
    moderate: "bg-amber-50 border-amber-200 text-amber-800 border",
    high: "bg-orange-50 border-orange-200 text-orange-800 border",
    critical: "bg-red-50 border-red-200 text-red-800",
  }

  const iconByLevel: Record<string, string> = {
    moderate: "i-focal-warning text-amber-500",
    high: "i-focal-warning text-orange-500",
    critical: "i-focal-warning text-red-500",
  }

  const resetEta = projectedLimitTime ? formatEta(projectedLimitTime) : null

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-md border p-3",
        stylesByLevel[level] || stylesByLevel.moderate,
        className,
      )}
    >
      <i className={cn(iconByLevel[level] || iconByLevel.moderate, "size-5 shrink-0")} />
      <div className="text-sm">
        <div className="font-medium">{t("usage_analysis.warning.title")}</div>
        <div className="text-xs opacity-90">
          <span>
            {resetEta
              ? t("usage_analysis.warning.projected", { eta: resetEta })
              : t("usage_analysis.warning.general")}
          </span>
          {detailed && usageRate ? (
            <span> · {t("usage_analysis.warning.rate", { rate: Math.round(usageRate) })}</span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function formatEta(ts: number) {
  const diff = ts - Date.now()
  if (diff <= 0) return "now"
  const minutes = Math.round(diff / 60000)
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rem = minutes % 60
  return rem ? `${hours}h ${rem}m` : `${hours}h`
}
