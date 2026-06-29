import type { SupportedActionLanguage } from "@follow/shared/language"
import { getStorageNS } from "@follow/utils/ns"
import type {
  ActionFilterItem,
  ActionItem as ActionItemRes,
  ActionOperation,
} from "@follow-app/client-sdk"

import type { EntryModel } from "../entry/types"
import {
  entryQualityScoreActions,
  entryQualityScoreSyncService,
} from "../entry-quality-score/store"
import type { FeedModel } from "../feed/types"
import type { SubscriptionModel } from "../subscription/types"
import type { ActionItem } from "./store"

const LOCAL_ACTION_RULES_STORAGE_KEY = getStorageNS("local_action_rules")
const LOCAL_ACTION_EFFECTS_STORAGE_KEY = getStorageNS("local_action_effects")

type LocalActionRulePayload = {
  version: "1.0"
  rules: Array<Omit<ActionItem, "index">>
}

type RawActionRule = ActionItem | ActionItemRes | Omit<ActionItem, "index">

export type LocalActionContext = {
  feed?: Partial<FeedModel> | null
  subscription?: Partial<SubscriptionModel> | null
  view?: number
  rules?: ActionItem[]
}

export type LocalActionSideEffectContext = Pick<LocalActionContext, "feed" | "view"> & {
  actionLanguage?: SupportedActionLanguage
  fetchReadabilityContent?: (entry: EntryModel) => Promise<void>
}

export type LocalActionResult = {
  entry: EntryModel
  blocked: boolean
  starred: boolean
  shouldNotify: boolean
  skipEnrichment: boolean
  webhooks: string[]
  matchedRules: ActionItem[]
}

const canUseLocalStorage = () => typeof localStorage !== "undefined"

const normalizeConditions = (condition: unknown): ActionFilterItem[][] => {
  if (!Array.isArray(condition)) return []
  if (condition.length === 0) return []
  return Array.isArray(condition[0])
    ? (condition as ActionFilterItem[][])
    : [condition as ActionFilterItem[]]
}

export const normalizeLocalActionRules = (rules: RawActionRule[] | undefined): ActionItem[] => {
  return (rules ?? []).map((rule, index) => ({
    ...rule,
    condition: normalizeConditions(rule.condition),
    index,
  }))
}

export const loadLocalActionRules = (): ActionItem[] => {
  if (!canUseLocalStorage()) return []

  const raw = localStorage.getItem(LOCAL_ACTION_RULES_STORAGE_KEY)
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw) as Partial<LocalActionRulePayload> | RawActionRule[]
    const rules = Array.isArray(parsed) ? parsed : parsed.rules
    return normalizeLocalActionRules(rules)
  } catch {
    return []
  }
}

export const saveLocalActionRules = (rules: ActionItem[]) => {
  if (!canUseLocalStorage()) return

  const payload: LocalActionRulePayload = {
    version: "1.0",
    rules: normalizeLocalActionRules(rules).map(({ index: _index, ...rule }) => rule),
  }
  localStorage.setItem(LOCAL_ACTION_RULES_STORAGE_KEY, JSON.stringify(payload))
}

const loadExecutedEffects = () => {
  if (!canUseLocalStorage()) return new Set<string>()

  try {
    const raw = localStorage.getItem(LOCAL_ACTION_EFFECTS_STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as string[]) : []
    return new Set(parsed)
  } catch {
    return new Set<string>()
  }
}

const saveExecutedEffects = (effects: Set<string>) => {
  if (!canUseLocalStorage()) return
  localStorage.setItem(LOCAL_ACTION_EFFECTS_STORAGE_KEY, JSON.stringify(Array.from(effects)))
}

const runOnce = async (key: string, task: () => Promise<void> | void) => {
  const executedEffects = loadExecutedEffects()
  if (executedEffects.has(key)) return

  await task()
  executedEffects.add(key)
  saveExecutedEffects(executedEffects)
}

const toComparableString = (value: unknown) => {
  if (value === null || value === undefined) return ""
  return String(value)
}

const toNumber = (value: unknown) => {
  if (typeof value === "number") return value
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const textContains = (actual: unknown, expected: unknown) => {
  return toComparableString(actual)
    .toLowerCase()
    .includes(toComparableString(expected).toLowerCase())
}

const compareValues = (
  actual: unknown,
  operator: ActionOperation | undefined,
  expected: unknown,
) => {
  switch (operator) {
    case "contains": {
      return textContains(actual, expected)
    }
    case "not_contains": {
      return !textContains(actual, expected)
    }
    case "eq": {
      return toComparableString(actual) === toComparableString(expected)
    }
    case "not_eq": {
      return toComparableString(actual) !== toComparableString(expected)
    }
    case "gt": {
      return toNumber(actual) > toNumber(expected)
    }
    case "lt": {
      return toNumber(actual) < toNumber(expected)
    }
    case "regex": {
      try {
        return new RegExp(toComparableString(expected)).test(toComparableString(actual))
      } catch {
        return false
      }
    }
    default: {
      return false
    }
  }
}

const getTotalAttachmentDuration = (entry: EntryModel) => {
  return (
    entry.attachments?.reduce((total, attachment) => {
      const duration = Number(attachment.duration_in_seconds ?? 0)
      return total + (Number.isFinite(duration) ? duration : 0)
    }, 0) ?? 0
  )
}

const getConditionFieldValue = (
  item: ActionFilterItem,
  entry: EntryModel,
  { feed, subscription, view }: LocalActionContext,
) => {
  switch (item.field) {
    case "status": {
      return entry.read ? "read" : "unread"
    }
    case "view": {
      return subscription?.view ?? view
    }
    case "title": {
      return subscription?.title ?? feed?.title
    }
    case "category": {
      return subscription?.category
    }
    case "site_url": {
      return feed?.siteUrl
    }
    case "feed_url": {
      return feed?.url
    }
    case "entry_title": {
      return entry.title
    }
    case "entry_content": {
      return entry.content
    }
    case "entry_url": {
      return entry.url
    }
    case "entry_author": {
      return entry.author
    }
    case "entry_media_length": {
      return entry.media?.length ?? 0
    }
    case "entry_attachments_duration": {
      return getTotalAttachmentDuration(entry)
    }
    default: {
      return ""
    }
  }
}

const doesConditionMatch = (
  item: ActionFilterItem,
  entry: EntryModel,
  context: LocalActionContext,
) => {
  if (!item.field || !item.operator) return false
  const actual = getConditionFieldValue(item, entry, context)
  return compareValues(actual, item.operator, item.value)
}

export const doesLocalActionRuleMatch = (
  rule: ActionItem,
  entry: EntryModel,
  context: LocalActionContext,
) => {
  if (rule.result.disabled) return false
  if (rule.condition.length === 0) return true

  return rule.condition.some(
    (group) => group.length > 0 && group.every((item) => doesConditionMatch(item, entry, context)),
  )
}

const rewriteText = (
  value: string | null | undefined,
  rewriteRules: NonNullable<ActionItem["result"]["rewriteRules"]>,
) => {
  if (!value) return value
  return rewriteRules.reduce((result, rule) => {
    if (!rule.from) return result
    return result.split(rule.from).join(rule.to ?? "")
  }, value)
}

const applyRewriteRules = (entry: EntryModel, rule: ActionItem) => {
  const { rewriteRules } = rule.result
  if (!rewriteRules || rewriteRules.length === 0) return entry

  return {
    ...entry,
    title: rewriteText(entry.title, rewriteRules),
    description: rewriteText(entry.description, rewriteRules),
    content: rewriteText(entry.content, rewriteRules),
  }
}

export const applyLocalActionRulesToEntry = (
  entry: EntryModel,
  context: LocalActionContext = {},
): LocalActionResult => {
  const rules = context.rules ?? []
  const matchedRules = rules.filter((rule) => doesLocalActionRuleMatch(rule, entry, context))
  let nextEntry = { ...entry }
  let blocked = false
  let starred = false
  let shouldNotify = false
  let skipEnrichment = false
  const webhooks: string[] = []

  for (const rule of matchedRules) {
    nextEntry = applyRewriteRules(nextEntry, rule)

    const { result } = rule
    if (result.summary || result.translation || result.readability || result.sourceContent) {
      nextEntry.settings = {
        ...nextEntry.settings,
        ...(result.summary ? { summary: result.summary } : null),
        ...(result.translation ? { translation: result.translation } : null),
        ...(result.readability ? { readability: result.readability } : null),
        ...(result.sourceContent ? { sourceContent: result.sourceContent } : null),
      }
    }

    if (result.silence) {
      nextEntry.read = true
    }
    if (result.block) {
      blocked = true
    }
    if (result.star) {
      starred = true
    }
    if (result.newEntryNotification) {
      shouldNotify = true
    }
    if (result.skipEnrichment) {
      skipEnrichment = true
    }
    if (result.webhooks) {
      webhooks.push(...result.webhooks.filter(Boolean))
    }
  }

  return {
    entry: nextEntry,
    blocked,
    starred,
    shouldNotify,
    skipEnrichment,
    webhooks: Array.from(new Set(webhooks)),
    matchedRules,
  }
}

export const runLocalActionSideEffects = async (
  result: LocalActionResult,
  context: LocalActionSideEffectContext = {},
) => {
  const { entry } = result
  const shouldFetchReadability = result.matchedRules.some((rule) => !!rule.result.readability)
  const shouldScoreReadability = result.matchedRules.some(
    (rule) => !!rule.result.readabilityQualityScore,
  )

  if (
    (shouldFetchReadability || shouldScoreReadability) &&
    !result.blocked &&
    context.fetchReadabilityContent
  ) {
    await runOnce(`readability:${entry.id}`, async () => {
      await context.fetchReadabilityContent?.(entry)
    }).catch((error) => {
      console.warn("[actions] Failed to fetch readability content:", entry.id, error)
    })
  }

  const { actionLanguage } = context
  if (shouldScoreReadability && !result.blocked && actionLanguage) {
    await runOnce(`readability-quality-score:${entry.id}`, async () => {
      await entryQualityScoreActions.deleteMany([entry.id])
      await entryQualityScoreSyncService.generateScore({
        entryId: entry.id,
        actionLanguage,
        target: "readabilityContent",
      })
    }).catch((error) => {
      console.warn("[actions] Failed to score readability content:", entry.id, error)
    })
  } else if (shouldScoreReadability && !result.blocked) {
    console.warn("[actions] Skipped readability quality score; action language is unavailable.")
  }

  if (result.shouldNotify && typeof Notification !== "undefined") {
    await runOnce(`notification:${entry.id}`, async () => {
      if (Notification.permission === "default") {
        await Notification.requestPermission()
      }
      if (Notification.permission !== "granted") return

      new Notification(entry.title || "New entry", {
        body: entry.description || context.feed?.title || undefined,
      })
    }).catch((error) => {
      console.warn("[actions] Failed to show local notification:", error)
    })
  }

  if (result.webhooks.length > 0 && typeof fetch !== "undefined") {
    await Promise.all(
      result.webhooks.map((webhook) =>
        runOnce(`webhook:${entry.id}:${webhook}`, async () => {
          await fetch(webhook, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              entry,
              feed: context.feed ?? null,
              view: context.view ?? null,
            }),
          })
        }).catch((error) => {
          console.warn("[actions] Failed to run local webhook:", webhook, error)
        }),
      ),
    )
  }
}
