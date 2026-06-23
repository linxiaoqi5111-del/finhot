/**
 * Local type definitions to replace @folo-services/ai-tools
 * These types are used for AI chat UI components and message handling
 *
 * This file precisely mirrors the types from @folo-services/ai-tools
 * to maintain type compatibility without the external dependency.
 */

/**
 * Metadata for AI messages including token usage
 */
export interface BizUIMetadata {
  finishTime?: string
  totalTokens?: number
  reasoningTokens?: number
  billedTokens?: number
  contextTokens?: number
  outputTokens?: number
  billingMultiplier?: number
  cachedInputTokens?: number
  remainingTokens?: number
  duration?: number
  modelUsed?: string
  providerType?: "byok" | "system"
  provider?: string
}

/**
 * Tool input/output types
 * Precisely matching the schema from @folo-services/ai-tools
 */
export type BizUITools = {
  display_flow_chart: {
    input: {
      schema: any
    }
    output:
      | {
          error: string
          message: string
          ok?: undefined
        }
      | {
          ok: number
          error?: undefined
          message?: undefined
        }
  }
  get_flow_chart_schema: {
    input: Record<string, never>
    output: any
  }
  get_feeds: {
    input: {
      id: string | string[]
    }
    output: string | never[] | null
  }
  get_entries: {
    input: {
      id: string | string[]
      mode: "concise" | "detailed"
    }
    output: string | string[] | null
  }
  get_whoami: {
    input: {
      select?:
        | (
            | "email"
            | "name"
            | "id"
            | "emailVerified"
            | "image"
            | "handle"
            | "createdAt"
            | "updatedAt"
            | "twoFactorEnabled"
            | "bio"
            | "website"
            | "socialLinks"
          )[]
        | undefined
    }
    output: string
  }
  search: {
    input: {
      scope:
        | "feeds.all"
        | "feeds.userSubscriptions"
        | "entries.all"
        | "entries.userTimeline"
        | "entries.userStarred"
      query:
        | (
            | {
                field:
                  | "feeds.name"
                  | "feeds.description"
                  | "feeds.url"
                  | "feeds.siteUrl"
                  | "feeds.rsshubRoute"
                  | "feeds.userSubscriptionsCategory"
                  | "entries.content"
                  | "entries.author"
                  | "entries.feedId"
                operation: "eq" | "ilike"
                value: string | string[]
              }
            | {
                field:
                  | "feeds.userSubscriptionsView"
                  | "feeds.subscriptionCount"
                  | "feeds.updatesPerWeek"
                  | "feeds.subscriptionCount"
                  | "entries.userTimelineView"
                operation: "eq" | "gt" | "lt"
                value: number
              }
            | {
                field: "entries.userTimelineRead"
                operation: "eq"
                value: boolean
              }
            | {
                field: "entries.publishedAt"
                operation: "eq" | "gt" | "lt"
                value: string
              }
          )[]
        | null
      order?:
        | {
            field: "feeds.subscriptionCount" | "feeds.updatesPerWeek" | "entries.publishedAt"
            direction: "asc" | "desc"
          }
        | null
        | undefined
    }
    output: string
  }
  onboardingGetTrendingFeeds: {
    input: {
      language: "eng" | "cmn"
      user_description: string
    }
    output: string | never[]
  }
  onboardingConfirm: {
    input: Record<string, never>
    output: {
      confirm: boolean
    }
  }
} & Record<
  string,
  {
    input: unknown
    output: unknown | undefined
  }
>

/**
 * Adds state tracking to a tool type
 */
export type ToolWithState<T> = T & {
  state: "input-streaming" | "input-available" | "output-available" | "output-error"
}
