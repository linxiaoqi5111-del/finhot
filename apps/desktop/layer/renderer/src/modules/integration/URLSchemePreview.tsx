import { Button } from "@follow/components/ui/button/index.js"
import type { URLSchemeTemplate } from "@follow/shared/settings/interface"
import { cn } from "@follow/utils"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { CustomIntegrationManager } from "./custom-integration-manager"

interface URLSchemePreviewProps {
  urlSchemeTemplate: URLSchemeTemplate
  className?: string
}

export const URLSchemePreview = ({ urlSchemeTemplate, className }: URLSchemePreviewProps) => {
  const { t } = useTranslation("settings")
  const [preview, setPreview] = useState<string | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const generatePreview = async (template: URLSchemeTemplate) => {
    setIsLoading(true)
    try {
      const previewScheme = CustomIntegrationManager.getURLSchemePreview(template)
      setPreview(previewScheme)
    } catch (error) {
      console.error("Failed to generate URL scheme preview:", error)
      setPreview(null)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className={cn("space-y-2", className)}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        buttonClassName="w-full py-2"
        textClassName="flex w-full justify-between"
        onClick={() => {
          setIsOpen(!isOpen)
          if (!isOpen) {
            generatePreview(urlSchemeTemplate)
          }
        }}
      >
        <span className="flex items-center gap-2">
          <i className="i-focal-eye-2" />
          {t("integration.custom_integrations.preview.url_scheme_title")}
        </span>
        <i className={cn("i-focal-right transition-transform", isOpen && "rotate-90")} />
      </Button>

      {isOpen && (
        <div className="space-y-3">
          {isLoading ? (
            <div className="flex items-center justify-center rounded-lg bg-material-medium p-4">
              <div className="flex items-center gap-2">
                <i className="i-focal-loading-3 animate-spin" />
                <span className="text-sm text-text-tertiary">
                  {t("integration.custom_integrations.preview.generating")}
                </span>
              </div>
            </div>
          ) : preview ? (
            <div className="space-y-3 rounded-lg bg-material-medium p-4">
              {/* URL Scheme Preview */}
              <div>
                <h4 className="mb-2 text-sm font-medium text-text-secondary">
                  {t("integration.custom_integrations.preview.generated_url_scheme")}
                </h4>
                <div className="flex items-center gap-2 rounded bg-material-medium p-2 font-mono text-sm">
                  <span className="rounded bg-green/10 px-2 py-1 text-xs font-bold text-green">
                    {t("integration.custom_integrations.preview.scheme_badge")}
                  </span>
                  <span className="break-all text-text-secondary">{preview}</span>
                </div>
              </div>

              {/* Protocol Info */}
              <div>
                <h4 className="mb-2 text-sm font-medium text-text-secondary">
                  {t("integration.custom_integrations.preview.protocol_information")}
                </h4>
                <div className="space-y-1 rounded bg-material-medium p-2">
                  <div className="flex font-mono text-sm">
                    <span className="min-w-0 flex-shrink-0 pr-2 text-text-secondary">
                      {t("integration.custom_integrations.preview.protocol_label")}:
                    </span>
                    <span className="min-w-0 flex-1 break-all text-text-tertiary">
                      {preview.split("://")[0]}://
                    </span>
                  </div>
                  <div className="flex font-mono text-sm">
                    <span className="min-w-0 flex-shrink-0 pr-2 text-text-secondary">
                      {t("integration.custom_integrations.preview.url_scheme_action_label")}:
                    </span>
                    <span className="min-w-0 flex-1 break-all text-text-tertiary">
                      {preview.includes("?")
                        ? t(
                            "integration.custom_integrations.preview.url_scheme_action_with_parameters",
                          )
                        : t(
                            "integration.custom_integrations.preview.url_scheme_action_direct_open",
                          )}
                    </span>
                  </div>
                </div>
              </div>

              {/* Placeholders Info */}
              <div className="border-t border-border pt-3">
                <h4 className="mb-2 text-sm font-medium text-text-secondary">
                  {t("integration.custom_integrations.preview.placeholders")}
                </h4>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {CustomIntegrationManager.getAvailablePlaceholders().map((placeholder) => (
                    <div key={placeholder.key} className="rounded bg-material-opaque p-2">
                      <code className="font-bold text-text">{placeholder.key}</code>
                      <div className="mt-1 text-text-tertiary">{placeholder.description}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Usage Note */}
              <div className="rounded border border-blue/20 bg-blue/10 p-3">
                <div className="flex items-start gap-2">
                  <i className="i-focal-information mt-0.5 flex-shrink-0 text-blue" />
                  <div className="text-sm text-blue">
                    <div className="mb-1 font-medium">
                      {t("integration.custom_integrations.preview.url_scheme_behavior")}
                    </div>
                    <div className="text-blue/80">
                      {t("integration.custom_integrations.preview.url_scheme_behavior_description")}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center rounded-lg bg-material-medium p-4">
              <span className="text-sm text-text-tertiary">
                {t("integration.custom_integrations.preview.failed")}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
