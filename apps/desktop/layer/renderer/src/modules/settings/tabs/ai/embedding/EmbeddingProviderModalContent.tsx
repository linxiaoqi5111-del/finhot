import { Button } from "@follow/components/ui/button/index.js"
import { Input } from "@follow/components/ui/input/index.js"
import { Label } from "@follow/components/ui/label/index.jsx"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@follow/components/ui/select/index.js"
import type {
  EmbeddingProviderPreset,
  UserEmbeddingProviderConfig,
} from "@follow/shared/settings/interface"
import type { FormEvent } from "react"
import { useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  EMBEDDING_PROVIDER_PRESETS,
  getEmbeddingDefaultConfig,
  getEmbeddingProviderPreset,
} from "./constants"

interface EmbeddingProviderModalContentProps {
  provider: UserEmbeddingProviderConfig | null
  onSave: (provider: UserEmbeddingProviderConfig) => void
  onCancel: () => void
}

export const EmbeddingProviderModalContent = ({
  provider,
  onSave,
  onCancel,
}: EmbeddingProviderModalContentProps) => {
  const { t } = useTranslation("ai")
  const initialPreset = provider?.preset ?? "siliconflow"

  // Remember per-preset configuration (especially API keys) during the lifetime of this modal.
  // This allows switching presets and coming back to a previously configured one (or one the user
  // just typed a key for) without losing the API key — exactly like the BYOK provider switch fix.
  const configMemory = useRef<
    Partial<Record<EmbeddingProviderPreset, Partial<UserEmbeddingProviderConfig>>>
  >({})

  // Seed memory with the currently saved provider (if any) so we can restore its key when switching back
  if (provider && !configMemory.current[provider.preset]) {
    configMemory.current[provider.preset] = { ...provider }
  }

  const [formData, setFormData] = useState<UserEmbeddingProviderConfig>(() => ({
    ...(provider ?? getEmbeddingDefaultConfig(initialPreset)),
  }))

  // Always keep a ref to the absolute latest form values so preset switching can capture
  // the most recently typed API key / baseURL etc without stale closure issues.
  const latestFormRef = useRef(formData)
  latestFormRef.current = formData

  const selectedPreset = useMemo(
    () => getEmbeddingProviderPreset(formData.preset),
    [formData.preset],
  )

  const handlePresetChange = (value: string) => {
    const preset = value as EmbeddingProviderPreset
    const defaults = getEmbeddingDefaultConfig(preset)

    // Capture the absolute latest values the user has typed for the *previous* preset
    const latest = latestFormRef.current
    configMemory.current[latest.preset] = {
      ...configMemory.current[latest.preset],
      apiKey: latest.apiKey,
      baseURL: latest.baseURL,
      model: latest.model,
      dimension: latest.dimension,
    }

    const remembered = configMemory.current[preset] || {}

    setFormData({
      preset,
      baseURL: remembered.baseURL ?? defaults.baseURL,
      model: remembered.model ?? defaults.model,
      dimension: remembered.dimension ?? defaults.dimension,
      apiKey: remembered.apiKey ?? null,
    })
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    onSave({
      ...formData,
      baseURL: formData.baseURL || selectedPreset?.defaultBaseURL || "",
      model: formData.model || selectedPreset?.defaultModel || "",
      dimension: formData.dimension || selectedPreset?.dimension || 1024,
      // Convert empty string to null so API key validation works correctly
      // Empty string is falsy but not null, causing issues with the !! check
      apiKey: formData.apiKey?.trim() || null,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="min-w-[40ch] space-y-4">
      <div className="space-y-2">
        <Label htmlFor="embedding-preset">{t("embedding.providers.form.preset")}</Label>
        <Select value={formData.preset} onValueChange={handlePresetChange}>
          <SelectTrigger id="embedding-preset">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EMBEDDING_PROVIDER_PRESETS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <span className="flex items-center gap-2">
                  <i className={`${option.iconClassName} size-4 text-text-secondary`} />
                  <span>{option.label}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="embedding-base-url">{t("embedding.providers.form.base_url")}</Label>
        <Input
          id="embedding-base-url"
          value={formData.baseURL}
          placeholder={
            selectedPreset?.defaultBaseURL ?? t("embedding.providers.form.base_url_placeholder")
          }
          onChange={(event) => setFormData((prev) => ({ ...prev, baseURL: event.target.value }))}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="embedding-model">{t("embedding.providers.form.model")}</Label>
        <Input
          id="embedding-model"
          value={formData.model}
          placeholder={
            selectedPreset?.defaultModel ?? t("embedding.providers.form.model_placeholder")
          }
          onChange={(event) => setFormData((prev) => ({ ...prev, model: event.target.value }))}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="embedding-dimension">{t("embedding.providers.form.dimension")}</Label>
        <Input
          id="embedding-dimension"
          type="number"
          min={1}
          value={formData.dimension}
          onChange={(event) =>
            setFormData((prev) => ({
              ...prev,
              dimension: Number.parseInt(event.target.value, 10) || prev.dimension,
            }))
          }
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="embedding-api-key">{t("embedding.providers.form.api_key")}</Label>
        <Input
          id="embedding-api-key"
          type="password"
          value={formData.apiKey ?? ""}
          placeholder={t("embedding.providers.form.api_key_placeholder")}
          onChange={(event) =>
            setFormData((prev) => ({ ...prev, apiKey: event.target.value || null }))
          }
        />
        <p className="text-xs text-text-secondary">{t("embedding.providers.form.api_key_help")}</p>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("words.cancel", { ns: "common" })}
        </Button>
        <Button type="submit">{t("words.save", { ns: "common" })}</Button>
      </div>
    </form>
  )
}
