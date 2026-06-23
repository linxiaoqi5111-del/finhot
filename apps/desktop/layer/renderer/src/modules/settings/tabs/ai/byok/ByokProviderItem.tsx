import { Button } from "@follow/components/ui/button/index.js"
import { Tooltip, TooltipContent, TooltipTrigger } from "@follow/components/ui/tooltip/index.jsx"
import type { UserByokProviderConfig } from "@follow/shared/settings/interface"
import { useTranslation } from "react-i18next"

import { getProviderDefaultBaseURL, getProviderDefaultModel, getProviderOption } from "./constants"

interface ByokProviderItemProps {
  provider: UserByokProviderConfig
  onDelete: () => void
  onEdit: () => void
}

export const ByokProviderItem = ({ provider, onEdit, onDelete }: ByokProviderItemProps) => {
  const { t } = useTranslation("ai")

  const providerOption = getProviderOption(provider.provider)
  const providerLabel = providerOption?.label ?? provider.provider
  const baseURL = provider.baseURL ?? getProviderDefaultBaseURL(provider.provider)
  const model = provider.model ?? getProviderDefaultModel(provider.provider)

  return (
    <div className="group rounded-lg border border-border p-3 transition-colors hover:bg-material-medium">
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            {providerOption?.iconClassName && (
              <i className={`${providerOption.iconClassName} size-4 text-text-secondary`} />
            )}
            <h4 className="text-sm font-medium text-text">{providerLabel}</h4>
            <span className="inline-flex rounded-full bg-accent/10 px-2 py-1 text-xs text-accent">
              {t("byok.providers.configured")}
            </span>
          </div>
          <div className="mt-1 space-y-0.5 text-xs text-text-secondary">
            {!!model && <div className="truncate">{model}</div>}
            {!!baseURL && <div className="truncate">{baseURL}</div>}
          </div>
        </div>

        <div className="ml-4 flex items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={onEdit}>
                <i className="i-focal-edit size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("byok.providers.edit")}</TooltipContent>
          </Tooltip>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={onDelete}>
                <i className="i-focal-delete-2 size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("byok.providers.delete")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
