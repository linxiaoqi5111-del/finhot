import {
  ENTRY_AI_TAG_CANDIDATES,
  ENTRY_CONTENT_TYPE_CANDIDATES,
  MAX_ENTRY_AI_TAGS,
} from "@follow/shared/entry-ai-tags"
import type { TagGenerator } from "@follow/store/context"

import { getAISettings } from "~/atoms/settings/ai"
import {
  getProviderOption,
  getSafeTemperature,
  resolveConfiguredByokProvider,
} from "~/modules/settings/tabs/ai/byok/constants"

import { requestOpenAICompatibleChatCompletion } from "./local-byok-request"

const MAX_TAG_SOURCE_LENGTH = 12_000

const htmlToText = (content: string) => {
  if (!content.trim()) return ""

  const parser = new DOMParser()
  const document = parser.parseFromString(content, "text/html")
  document.querySelectorAll("script, style, noscript").forEach((element) => element.remove())

  return (document.body.textContent || content).replaceAll(/\s+/g, " ").trim()
}

const buildTagSource = (input: Parameters<TagGenerator>[0]) => {
  const title = input.entry.title?.trim()
  const description = input.entry.description?.trim()
  const content = htmlToText(input.entry.content || "")

  return [
    title ? `Title: ${title}` : "",
    description ? `Description: ${description}` : "",
    input.summary ? `Summary: ${input.summary}` : "",
    content ? `Content: ${content.slice(0, MAX_TAG_SOURCE_LENGTH)}` : "",
    input.entry.url ? `URL: ${input.entry.url}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

const parseTagResponse = (raw: string) => {
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null

  try {
    return JSON.parse(jsonMatch[0]) as unknown
  } catch {
    return null
  }
}

export const generateLocalByokTags: TagGenerator = async (input) => {
  const source = buildTagSource(input)
  if (!source.trim()) {
    return { tags: [] }
  }

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

  const candidateLabels = ENTRY_AI_TAG_CANDIDATES.join("、")
  const contentTypeLabels = ENTRY_CONTENT_TYPE_CANDIDATES.join("、")
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
            "You classify RSS reader entries. Return JSON only. Never invent labels outside the allowed list.",
        },
        {
          role: "user",
          content: `Classify this entry on two axes.

Axis 1 — topic tags, using ONLY labels from this list: ${candidateLabels}.
Axis 2 — contentType (the genre/how it is written), exactly ONE label from this list: ${contentTypeLabels}.

contentType guidance:
- 快讯: short news/announcement of a single event (released, launched, funded)
- 合集: digest/roundup covering many unrelated items (daily/weekly newsletter)
- 教程: how-to / step-by-step guide
- 实测: hands-on test/review with results, screenshots, benchmarks
- 分析: in-depth analysis explaining why/how
- 观点: opinion/commentary/prediction with the author's stance
- 论文: academic paper or paper walkthrough
- 其他: none clearly fits

Return JSON in this shape:
{"tags":[{"label":"AI","confidence":0.86,"reason":"一句话说明为什么选这个标签"}],"contentType":{"label":"分析","confidence":0.8}}

Rules:
- Select 0 to ${MAX_ENTRY_AI_TAGS} topic labels; each label must exactly match one allowed topic label
- contentType.label must exactly match one allowed contentType label; pick 其他 when unsure
- all confidence values must be between 0 and 1
- reason must be one short sentence in Chinese and must not copy the summary verbatim
- prefer fewer high-confidence labels over many weak labels

Entry:
${source}`,
        },
      ],
      temperature: getSafeTemperature(resolvedProvider.provider.provider, 0.1),
      stream: false,
    },
  })
  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) {
    return { tags: [] }
  }

  const parsed = parseTagResponse(content)
  if (!parsed || typeof parsed !== "object" || !("tags" in parsed) || !Array.isArray(parsed.tags)) {
    return { tags: [] }
  }

  return {
    tags: parsed.tags
      .filter((tag): tag is { label: string; confidence: number; reason: string } => {
        return (
          !!tag &&
          typeof tag === "object" &&
          typeof tag.label === "string" &&
          typeof tag.confidence === "number" &&
          typeof tag.reason === "string"
        )
      })
      .map((tag) => ({
        label: tag.label,
        confidence: tag.confidence,
        reason: tag.reason,
      })),
    contentType: parseContentType(parsed),
  }
}

const parseContentType = (parsed: object): { label: string; confidence: number } | null => {
  if (!("contentType" in parsed)) return null

  const raw = (parsed as { contentType: unknown }).contentType
  if (!raw || typeof raw !== "object") return null

  const record = raw as Record<string, unknown>
  if (typeof record.label !== "string") return null

  const confidenceValue =
    typeof record.confidence === "number" ? record.confidence : Number(record.confidence)

  return {
    label: record.label,
    confidence: Number.isFinite(confidenceValue) ? confidenceValue : 0,
  }
}
