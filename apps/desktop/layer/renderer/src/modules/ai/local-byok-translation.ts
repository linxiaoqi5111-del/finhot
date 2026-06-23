import type { SupportedActionLanguage } from "@follow/shared/language"
import { ACTION_LANGUAGE_MAP } from "@follow/shared/language"
import type {
  TranslationGenerator,
  TranslationGeneratorField,
  TranslationGeneratorResult,
} from "@follow/store/context"

import { getAISettings } from "~/atoms/settings/ai"
import {
  getProviderOption,
  getSafeTemperature,
  resolveConfiguredByokProvider,
} from "~/modules/settings/tabs/ai/byok/constants"

import { requestOpenAICompatibleChatCompletion } from "./local-byok-request"

const MAX_TRANSLATION_SOURCE_LENGTH = 24_000

const getFieldInstruction = (field: TranslationGeneratorField) => {
  switch (field) {
    case "title": {
      return "Translate the title only. Keep product names, abbreviations, and proper nouns in their original language when natural."
    }
    case "description": {
      return "Translate the description. Keep product names, abbreviations, and proper nouns in their original language when natural."
    }
    case "content":
    case "readabilityContent": {
      return "Translate the content. Preserve all HTML tags and structure. Only translate human-readable text. Keep product names, abbreviations, and proper nouns in their original language when natural."
    }
    default: {
      return "Translate the text. Keep proper nouns in their original language when natural."
    }
  }
}

const requestByokTranslation = async ({
  source,
  field,
  actionLanguage,
}: {
  source: string
  field: TranslationGeneratorField
  actionLanguage: SupportedActionLanguage
}) => {
  // For automatic enrichment, always use the BYOK provider currently configured in Settings.
  const resolvedProvider = resolveConfiguredByokProvider(getAISettings().byok)

  if (!resolvedProvider) {
    throw new Error(
      "No OpenAI-compatible BYOK provider is configured. Enable BYOK and add a provider in Settings > AI.",
    )
  }

  const providerOption = getProviderOption(resolvedProvider.provider.provider)
  if (!providerOption) {
    throw new Error("The selected BYOK provider is not supported.")
  }

  const languageLabel = ACTION_LANGUAGE_MAP[actionLanguage]?.label || actionLanguage
  const data = await requestOpenAICompatibleChatCompletion({
    baseURL: resolvedProvider.baseURL,
    apiKey: resolvedProvider.apiKey ?? undefined,
    headers: resolvedProvider.provider.headers,
    body: {
      model: resolvedProvider.model,
      messages: [
        {
          role: "system",
          content:
            "You translate RSS reader content. Return only the translated result without explanations or quotes.",
        },
        {
          role: "user",
          content: `${getFieldInstruction(field)} Translate into ${languageLabel}.\n\n${source.slice(0, MAX_TRANSLATION_SOURCE_LENGTH)}`,
        },
      ],
      temperature: getSafeTemperature(resolvedProvider.provider.provider, 0.2),
      stream: false,
    },
  })
  return data.choices?.[0]?.message?.content?.trim() || null
}

export const generateLocalByokTranslation: TranslationGenerator = async (input) => {
  const results: TranslationGeneratorResult = {}

  for (const field of input.fields) {
    const source = input.entry[field]
    if (!source?.trim()) continue

    const translated = await requestByokTranslation({
      source,
      field,
      actionLanguage: input.actionLanguage,
    })

    if (translated) {
      results[field] = translated
    }
  }

  return results
}
