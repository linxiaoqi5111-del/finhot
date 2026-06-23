import { Button } from "@follow/components/ui/button/index.js"
import { Label } from "@follow/components/ui/label/index.jsx"
import { Switch } from "@follow/components/ui/switch/index.jsx"
import type { UserEmbeddingProviderConfig } from "@follow/shared/settings/interface"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { getAISettings, setAISetting, useAISettingValue } from "~/atoms/settings/ai"
import { useDialog, useModalStack } from "~/components/ui/modal/stacked/hooks"

import { EmbeddingProcessingSection } from "../background-processing"
import { EmbeddingProviderItem } from "./EmbeddingProviderItem"
import { EmbeddingProviderModalContent } from "./EmbeddingProviderModalContent"

export const EmbeddingSection = () => {
  const { t } = useTranslation("ai")
  const aiSettings = useAISettingValue()
  const embedding = aiSettings.embedding ?? { enabled: false, provider: null }
  const { present } = useModalStack()
  const { ask } = useDialog()

  const handleToggleEnabled = (enabled: boolean) => {
    setAISetting("embedding", {
      ...embedding,
      enabled,
      provider: embedding.provider ?? null,
    })
  }

  const handleConfigureProvider = () => {
    present({
      title: embedding.provider
        ? t("embedding.providers.edit_title")
        : t("embedding.providers.configure_title"),
      content: ({ dismiss }: { dismiss: () => void }) => (
        <EmbeddingProviderModalContent
          provider={embedding.provider}
          onSave={(provider: UserEmbeddingProviderConfig) => {
            const current = getAISettings().embedding ?? { enabled: false, provider: null }
            setAISetting("embedding", {
              ...current,
              provider,
            })
            toast.success(t("embedding.providers.saved"))
            dismiss()
          }}
          onCancel={dismiss}
        />
      ),
    })
  }

  const handleDeleteProvider = async () => {
    const confirmed = await ask({
      title: t("embedding.providers.delete_title"),
      message: t("embedding.providers.delete_message"),
      confirmText: t("words.delete", { ns: "common" }),
      cancelText: t("words.cancel", { ns: "common" }),
      variant: "danger",
    })

    if (!confirmed) return

    const current = getAISettings().embedding ?? { enabled: false, provider: null }
    setAISetting("embedding", {
      ...current,
      provider: null,
    })
    toast.success(t("embedding.providers.deleted"))
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label className="text-sm font-medium text-text">{t("embedding.enabled")}</Label>
            <div className="text-xs text-text-secondary">{t("embedding.description")}</div>
          </div>
          <Switch checked={embedding.enabled} onCheckedChange={handleToggleEnabled} />
        </div>
      </div>

      {embedding.enabled ? (
        <>
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium text-text">
              {t("embedding.providers.title")}
            </Label>
            {!embedding.provider ? (
              <Button variant="outline" size="sm" onClick={handleConfigureProvider}>
                <i className="i-focal-add mr-2 size-4" />
                {t("embedding.providers.add")}
              </Button>
            ) : null}
          </div>

          {!embedding.provider ? (
            <div className="py-8 text-center">
              <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-fill-secondary">
                <i className="i-focal-vector-bezier-3 size-6 text-text" />
              </div>
              <h4 className="mb-1 text-sm font-medium text-text">
                {t("embedding.providers.empty.title")}
              </h4>
              <p className="text-xs text-text-secondary">
                {t("embedding.providers.empty.description")}
              </p>
            </div>
          ) : null}

          {embedding.provider ? (
            <div className="!mt-2 space-y-4">
              <EmbeddingProviderItem
                provider={embedding.provider}
                onEdit={handleConfigureProvider}
                onDelete={() => void handleDeleteProvider()}
              />
            </div>
          ) : null}

          <EmbeddingProcessingSection />
        </>
      ) : null}
    </div>
  )
}
