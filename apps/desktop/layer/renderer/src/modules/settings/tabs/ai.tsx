import { Label } from "@follow/components/ui/label/index.js"
import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { useTranslation } from "react-i18next"

import { setAISetting, useAISettingValue } from "~/atoms/settings/ai"

import { createDefineSettingItem } from "../helper/builder"
import { createSettingBuilder } from "../helper/setting-builder"
import { AIActionSettingsSection } from "./ai/AIActionSettingsSection"
import { ByokSection } from "./ai/byok"
import { EmbeddingSection } from "./ai/embedding"
import { MCPServicesSection } from "./ai/mcp/MCPServicesSection"
import { PanelStyleSection } from "./ai/PanelStyleSection"
import { UsageAnalysisSection } from "./ai/usage"

const SettingBuilder = createSettingBuilder(useAISettingValue)
const defineSettingItem = createDefineSettingItem("ai", useAISettingValue, setAISetting)

export const SettingAI = () => {
  const { t } = useTranslation("ai")

  return (
    <div className="mt-4">
      <SettingBuilder
        settings={[
          {
            type: "title",
            value: t("features.title"),
          },

          PanelStyleSection,
          defineSettingItem("autoScrollWhenStreaming", {
            label: t("settings.autoScrollWhenStreaming.label"),
            description: t("settings.autoScrollWhenStreaming.description"),
          }),
        ]}
      />

      <AIActionSettingsSection />

      <SettingBuilder
        settings={[
          ...(LOCAL_RSS_MODE
            ? []
            : ([
                {
                  type: "title" as const,
                  value: t("integration.title"),
                },
                MCPServicesSection,
              ] as const)),

          {
            type: "title",
            value: t("byok.title"),
          },
          ByokSection,

          ...(LOCAL_RSS_MODE
            ? ([
                {
                  type: "title" as const,
                  value: t("embedding.title"),
                },
                EmbeddingSection,
              ] as const)
            : []),

          ...(LOCAL_RSS_MODE
            ? []
            : ([
                {
                  type: "title" as const,
                  value: t("usage_analysis.title"),
                },
                UsageAnalysisSection,
              ] as const)),
          AISecurityDisclosureSection,
        ]}
      />
    </div>
  )
}

const AISecurityDisclosureSection = () => {
  const { t } = useTranslation("ai")

  return (
    <div className="mt-6 border-t border-fill-secondary pt-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <i className="i-focal-safety-certificate size-4 text-green" />
          <Label className="text-sm font-medium text-text">{t("integration.security.title")}</Label>
        </div>
        <p className="text-xs leading-relaxed text-text-secondary">
          {t("integration.security.description")}
        </p>
      </div>
    </div>
  )
}
