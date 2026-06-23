import { ENTRY_QUALITY_CONTENT_TYPES } from "@follow/shared/entry-quality-score"
import { ACTION_LANGUAGE_MAP } from "@follow/shared/language"
import type { QualityScoreGenerator, QualityScoreGeneratorInput } from "@follow/store/context"

import { getAISettings } from "~/atoms/settings/ai"
import { fetchYouTubeTranscript } from "~/lib/fetch-youtube-transcript"
import {
  getProviderOption,
  getSafeTemperature,
  resolveConfiguredByokProvider,
} from "~/modules/settings/tabs/ai/byok/constants"

import { requestOpenAICompatibleChatCompletion } from "./local-byok-request"

const MAX_SOURCE_LENGTH = 16_000
const MAX_TRANSCRIPT_LENGTH = 12_000
const MAX_CONTENT_WITH_TRANSCRIPT = 4_000

const htmlToText = (content: string) => {
  if (!content.trim()) return ""

  const parser = new DOMParser()
  const document = parser.parseFromString(content, "text/html")
  document.querySelectorAll("script, style, noscript").forEach((element) => element.remove())

  return (document.body.textContent || content).replaceAll(/\s+/g, " ").trim()
}

const buildSource = async (input: QualityScoreGeneratorInput) => {
  const title = input.entry.title?.trim()
  const description = input.entry.description?.trim()
  const targetContent =
    input.target === "readabilityContent"
      ? (input.entry.readabilityContent ?? input.entry.content)
      : input.entry.content
  const content = htmlToText(targetContent || "")
  const author = input.entry.author?.trim()
  const publishedAt = input.entry.publishedAt?.toISOString()

  let transcript: string | null = null
  if (input.isYouTubeFeed) {
    try {
      transcript = await fetchYouTubeTranscript({
        url: input.entry.url,
        guid: input.guid,
        language: input.actionLanguage,
      })
    } catch (error) {
      console.warn("[quality-score] YouTube transcript unavailable:", error)
    }
  }

  const contentLimit = transcript ? MAX_CONTENT_WITH_TRANSCRIPT : MAX_SOURCE_LENGTH

  return [
    title ? `Title: ${title}` : "",
    input.source ? `Source: ${input.source}` : "",
    input.entry.url ? `URL: ${input.entry.url}` : "",
    publishedAt ? `Published At: ${publishedAt}` : "",
    author ? `Author: ${author}` : "",
    input.summary ? `Summary: ${input.summary}` : "",
    description ? `Description: ${description}` : "",
    transcript ? `Transcript: ${transcript.slice(0, MAX_TRANSCRIPT_LENGTH)}` : "",
    content ? `Content: ${content.slice(0, contentLimit)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

const parseJsonResponse = (raw: string) => {
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null

  try {
    return JSON.parse(jsonMatch[0]) as unknown
  } catch {
    return null
  }
}

const SYSTEM_PROMPT = `You are an expert content analyst for an AI-powered RSS reader.

Your task is to evaluate RSS content for knowledge value.

You must:
1. Detect content types.
2. Score the article using six quality dimensions with the full 0-5 rubric below.
3. Explain the reasons clearly.
4. Output valid JSON only.

Do not judge whether the user personally likes the content.
Do not produce markdown.
Do not include extra text outside JSON.
Do not hallucinate facts not present in the input.
If the article content is insufficient, lower confidence and explain why.
Do not output quality_score. The application calculates it from dimension scores.

Critical scoring rules:
- Score each dimension independently. High signal_density does NOT justify high depth or actionability.
- Covering many topics (breadth) is NOT the same as high information_gain. Aggregated digests of third-party news rarely exceed information_gain 3.
- actionability 3+ requires concrete steps, commands, or a reproducible workflow the reader can follow. Knowing a product exists is NOT actionable.
- actionability 0 means pure news or announcements with no practical steps.
- depth 1 means headline-level "what happened" only. Structured sections with one-line summaries per item are still depth 1-2, not depth 4.
- originality 2 means aggregation or curation of third-party sources without original analysis.`

const DIMENSION_RUBRIC = `Six scoring dimensions (each 0-5 integer). Weights for quality_score:
information_gain 20%, depth 25%, evidence 15%, actionability 15%, originality 15%, signal_density 10%.

1. information_gain — Does this content provide new information?

1. information_gain — Does this content provide new information?
   0 = Pure repost | 1 = Repeated reporting | 2 = Minor new details
   3 = Multiple new facts | 4 = First-hand information | 5 = Original discovery

2. depth — How deeply does the content explain the topic?
   0 = Clickbait | 1 = News only | 2 = Basic explanation
   3 = Explains why | 4 = Explains how | 5 = Systematic analysis with cases, limitations, or tradeoffs

3. evidence — How well is the content supported by evidence?
   0 = Pure opinion | 1 = Personal feeling | 2 = Third-party references
   3 = Data or examples | 4 = Experiment or detailed case evidence
   5 = Experiment + data + verifiable sources

4. actionability — Can the reader apply this content?
   0 = Pure news | 1 = Trend discussion | 2 = Directional advice
   3 = Actionable suggestions | 4 = Step-by-step guidance | 5 = Fully reproducible workflow

5. originality — Does the author contribute original thinking or experience?
   0 = Repost | 1 = AI summary or generic summary | 2 = Aggregation
   3 = Personal viewpoint | 4 = Personal practice | 5 = Original framework or method

6. signal_density — How much useful information exists relative to filler?
   0 = Mostly filler | 1 = <10% useful | 2 = ~20% | 3 = ~40% | 4 = ~60% | 5 = >80% useful`

const TYPE_SPECIFIC_CONSTRAINTS = `Type-specific constraints (apply after detecting content_types):

- News >= 60%: depth <= 2, actionability <= 1, originality <= 2
- News >= 75% (single news or digest): information_gain <= 3 unless the author provides first-hand reporting
- Daily digest / roundup / multi-item curation: classify as News-dominant, originality = 2 (aggregation), actionability = 0
- ProductUpdate or model announcement without step-by-step usage: actionability <= 1, depth <= 2
- Tutorial or Workflow >= 30%: actionability may reach 4-5 only when concrete steps or commands are present
- Research: actionability is usually 0-2 unless reproducible methods are included`

const FEW_SHOT_EXAMPLES = `Reference examples (for calibration only — score the actual input, do not copy):

Example A — Daily digest / news roundup:
Input: Multi-section digest listing HN posts, YC startups, and tech headlines. Each item is 1-2 sentences summarizing third-party news.
Output: {"content_types":{"News":0.85,"ProductUpdate":0.15},"scores":{"information_gain":3,"depth":1,"evidence":2,"actionability":0,"originality":2,"signal_density":5},"positive_reasons":["High signal density with minimal filler.","Covers many relevant updates in one scan."],"negative_reasons":["Each item lacks depth and original analysis.","Mostly repackages third-party sources.","No actionable steps or reproducible workflow."],"confidence":0.88,"summary":"A daily AI news digest aggregating third-party tech headlines."}

Example B — Single news item:
Input: AI startup raised $100M Series B with investor quotes and brief market context.
Output: {"content_types":{"News":0.75,"ProductUpdate":0.15,"Opinion":0.1},"scores":{"information_gain":2,"depth":1,"evidence":2,"actionability":0,"originality":1,"signal_density":2},"positive_reasons":["Reports a concrete funding event."],"negative_reasons":["Low practical value.","Mostly repeats announcement information."],"confidence":0.9,"summary":"The article reports an AI startup Series B funding round."}

Example C — Model or product announcement (no tutorial):
Input: A post introducing a new AI model's capabilities, benchmark numbers, pricing, and availability. No usage steps.
Output: {"content_types":{"ProductUpdate":0.7,"News":0.2,"Research":0.1},"scores":{"information_gain":4,"depth":2,"evidence":4,"actionability":0,"originality":2,"signal_density":5},"positive_reasons":["Includes benchmark data and concrete specs.","High signal density."],"negative_reasons":["No implementation steps or reproducible workflow.","Mostly product announcement rather than independent analysis."],"confidence":0.88,"summary":"The post announces a new AI model with benchmark results and availability details."}

Example D — Tutorial with reproducible workflow:
Input: Step-by-step guide with commands, folder structure, and common mistakes for setting up a research automation workflow.
Output: {"content_types":{"Tutorial":0.6,"Workflow":0.3,"CaseStudy":0.1},"scores":{"information_gain":4,"depth":4,"evidence":3,"actionability":5,"originality":3,"signal_density":4},"positive_reasons":["Contains step-by-step guidance.","Provides a complete reproducible workflow."],"negative_reasons":["Evidence is mostly practical rather than data-backed."],"confidence":0.9,"summary":"A practical tutorial for building a research automation workflow."}`

const buildUserPrompt = (source: string, outputLanguageLabel: string) => {
  const contentTypes = ENTRY_QUALITY_CONTENT_TYPES.join(", ")

  return `Analyze the following RSS item.

${source}

Allowed content types: ${contentTypes}
Content type scores must add up to approximately 1.0.

${DIMENSION_RUBRIC}

${TYPE_SPECIFIC_CONSTRAINTS}

${FEW_SHOT_EXAMPLES}

Write summary, positive_reasons, and negative_reasons in ${outputLanguageLabel}.
Keep JSON keys in English. Keep scores object keys (information_gain, depth, evidence, actionability, originality, signal_density) in English.

Return JSON following this schema:
{
  "content_types": { "News": 0.85, "ProductUpdate": 0.15 },
  "scores": {
    "information_gain": 3,
    "depth": 1,
    "evidence": 2,
    "actionability": 0,
    "originality": 2,
    "signal_density": 5
  },
  "positive_reasons": ["reason 1"],
  "negative_reasons": ["reason 1"],
  "confidence": 0.88,
  "summary": "One-sentence neutral summary."
}`
}

export const generateLocalByokQualityScore: QualityScoreGenerator = async (input) => {
  const source = await buildSource(input)
  if (!source.trim()) {
    return {
      content_types: { News: 1 },
      scores: {
        information_gain: 0,
        depth: 0,
        evidence: 0,
        actionability: 0,
        originality: 0,
        signal_density: 0,
      },
      positive_reasons: [],
      negative_reasons: ["Input content is too short to evaluate reliably."],
      confidence: 0.3,
      summary: "Insufficient content for evaluation.",
    }
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

  const outputLanguageLabel =
    ACTION_LANGUAGE_MAP[input.actionLanguage]?.label || input.actionLanguage

  const data = await requestOpenAICompatibleChatCompletion({
    baseURL: resolvedProvider.baseURL,
    apiKey: resolvedProvider.apiKey ?? undefined,
    headers: resolvedProvider.provider.headers,
    body: {
      model: resolvedProvider.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(source, outputLanguageLabel) },
      ],
      temperature: getSafeTemperature(resolvedProvider.provider.provider, 0.1),
      stream: false,
    },
  })
  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) {
    throw new Error("BYOK provider returned an empty quality score response.")
  }

  const parsed = parseJsonResponse(content)
  if (!parsed || typeof parsed !== "object") {
    throw new Error("BYOK provider returned invalid quality score JSON.")
  }

  return parsed as Record<string, unknown>
}
