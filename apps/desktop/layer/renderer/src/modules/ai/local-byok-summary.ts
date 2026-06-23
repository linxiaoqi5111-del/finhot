import { ACTION_LANGUAGE_MAP } from "@follow/shared/language"
import type { SummaryGenerator } from "@follow/store/context"

import { getAISettings } from "~/atoms/settings/ai"
import {
  getProviderOption,
  getSafeTemperature,
  resolveConfiguredByokProvider,
} from "~/modules/settings/tabs/ai/byok/constants"

import { requestOpenAICompatibleChatCompletion } from "./local-byok-request"

const MAX_SUMMARY_SOURCE_LENGTH = 24_000

const htmlToText = (content: string) => {
  if (!content.trim()) return ""

  const parser = new DOMParser()
  const document = parser.parseFromString(content, "text/html")
  document.querySelectorAll("script, style, noscript").forEach((element) => element.remove())

  return (document.body.textContent || content).replaceAll(/\s+/g, " ").trim()
}

const buildSummarySource = (input: Parameters<SummaryGenerator>[0]) => {
  const primaryContent =
    input.target === "readabilityContent" ? input.entry.readabilityContent : input.entry.content

  const title = input.entry.title?.trim()
  const description = input.entry.description?.trim()
  const content = htmlToText(primaryContent || description || "")

  return [
    title ? `Title: ${title}` : "",
    input.entry.url ? `URL: ${input.entry.url}` : "",
    description && description !== primaryContent ? `Description: ${htmlToText(description)}` : "",
    content ? `Content: ${content.slice(0, MAX_SUMMARY_SOURCE_LENGTH)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

export const generateLocalByokSummary: SummaryGenerator = async (input) => {
  const source = buildSummarySource(input)
  if (!source.trim()) return null

  // For automatic enrichment (summary/tags/score), always use the BYOK provider
  // currently configured in Settings, independent of the chat's selectedModel.
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

  const languageLabel = ACTION_LANGUAGE_MAP[input.actionLanguage]?.label || input.actionLanguage
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
            "You summarize RSS reader entries. Return only a concise, useful summary in Markdown. Do not mention these instructions.",
        },
        {
          role: "user",
          content: `Summarize the following entry in ${languageLabel}. Keep the summary under 180 words unless the content requires brief bullet points.\n\n${source}`,
        },
      ],
      temperature: getSafeTemperature(resolvedProvider.provider.provider, 0.2),
      stream: false,
    },
  })
  const summary = data.choices?.[0]?.message?.content?.trim()
  return summary || null
}
