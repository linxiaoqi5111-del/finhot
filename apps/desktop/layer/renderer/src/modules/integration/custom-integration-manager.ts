import type {
  CustomIntegration,
  FetchTemplate,
  URLSchemeTemplate,
} from "@follow/shared/settings/interface"
import type { EntryModel } from "@follow/store/entry/types"
import { getSummary } from "@follow/store/summary/getters"
import { tracker } from "@follow/tracker"
import { toast } from "sonner"

import { getActionLanguage } from "~/atoms/settings/general"
import { getIntegrationSettings } from "~/atoms/settings/integration"
import { getI18n } from "~/i18n"

import { convertHtmlToIntegrationMarkdown } from "./entry-content-markdown"
import { getFetchAdapter } from "./fetch-adapter"
import { URLSchemeHandler } from "./url-scheme-handler"

/**
 * Placeholder values that can be used in custom integration templates
 */
export interface PlaceholderContext {
  title: string
  url: string
  contentHtml: string
  contentMarkdown: string
  summary: string
  author: string
  publishedAt: string
  description: string
  [key: string]: string
}

/**
 * Manager class for handling custom integrations
 */
export class CustomIntegrationManager {
  /**
   * Get entry content as markdown
   */
  private static async getEntryContentAsMarkdown(entry: EntryModel): Promise<string> {
    const content = entry.content || ""
    return convertHtmlToIntegrationMarkdown(content)
  }

  /**
   * Get description with optional summary
   */
  private static getDescription(entry: EntryModel): string {
    const { saveSummaryAsDescription } = getIntegrationSettings()
    const actionLanguage = getActionLanguage()

    if (!saveSummaryAsDescription) {
      return entry.description || ""
    }
    const summary = getSummary(entry.id, actionLanguage)
    return summary?.readabilitySummary || summary?.summary || entry.description || ""
  }

  /**
   * Build placeholder context from entry
   */
  static async buildPlaceholderContext(entry: EntryModel): Promise<PlaceholderContext> {
    const markdownContent = await this.getEntryContentAsMarkdown(entry)

    return {
      title: entry.title || "",
      url: entry.url || "",
      contentHtml: entry.content || "",
      contentMarkdown: markdownContent,
      summary: this.getDescription(entry),
      author: entry.author || "",
      publishedAt: entry.publishedAt?.toISOString() || "",
      description: entry.description || "",
    }
  }

  /**
   * Get all available placeholders with their descriptions
   */
  static getAvailablePlaceholders(): Array<{ key: string; description: string; example?: string }> {
    const t = getI18n().t.bind(getI18n())

    return [
      {
        key: "[title]",
        description: t("settings:integration.custom_integrations.placeholders.entry_title"),
        example: t("settings:integration.custom_integrations.placeholders.example_article_title"),
      },
      {
        key: "[url]",
        description: t("settings:integration.custom_integrations.placeholders.entry_url"),
        example: "https://example.com/article",
      },
      {
        key: "[content_html]",
        description: t("settings:integration.custom_integrations.placeholders.entry_content_html"),
      },
      {
        key: "[content_markdown]",
        description: t(
          "settings:integration.custom_integrations.placeholders.entry_content_markdown",
        ),
      },
      {
        key: "[summary]",
        description: t("settings:integration.custom_integrations.placeholders.entry_summary"),
      },
      {
        key: "[author]",
        description: t("settings:integration.custom_integrations.placeholders.entry_author"),
        example: t("settings:integration.custom_integrations.placeholders.example_author"),
      },
      {
        key: "[published_at]",
        description: t("settings:integration.custom_integrations.placeholders.entry_published_at"),
        example: "2024-01-01T12:00:00.000Z",
      },
      {
        key: "[description]",
        description: t("settings:integration.custom_integrations.placeholders.entry_description"),
      },
    ]
  }

  /**
   * Replace placeholders in a string with actual values
   */
  static replacePlaceholders(
    template: string,
    context: PlaceholderContext,
    options: {
      urlEncode?: boolean
      htmlEscape?: boolean
      jsonEscape?: boolean
    } = {},
  ): string {
    let result = template

    // Define placeholder mapping
    const placeholders: Record<string, string> = {
      "[title]": context.title,
      "[url]": context.url,
      "[content_html]": context.contentHtml,
      "[content_markdown]": context.contentMarkdown,
      "[summary]": context.summary,
      "[author]": context.author,
      "[published_at]": context.publishedAt,
      "[description]": context.description,
    }

    // Replace each placeholder
    Object.entries(placeholders).forEach(([placeholder, value]) => {
      let processedValue = value

      if (options.urlEncode) {
        processedValue = encodeURIComponent(processedValue)
      }

      if (options.htmlEscape) {
        processedValue = processedValue
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#x27;")
      }

      if (options.jsonEscape) {
        // Learn more https://stackoverflow.com/questions/4253367/how-to-escape-a-json-string-containing-newline-characters-using-javascript
        processedValue = JSON.stringify(processedValue).slice(1, -1)
      }

      result = result.replaceAll(placeholder, processedValue)
    })

    return result
  }

  /**
   * Process a fetch template with placeholder replacement
   */
  static async processFetchTemplate(
    fetchTemplate: FetchTemplate,
    context: PlaceholderContext,
  ): Promise<{
    url: string
    headers: Record<string, string>
    body?: string
    method: string
  }> {
    // Process URL with URL encoding for placeholder values
    const processedUrl = this.replacePlaceholders(fetchTemplate.url, context, { urlEncode: true })

    // Process headers without URL encoding
    const processedHeaders: Record<string, string> = {}
    Object.entries(fetchTemplate.headers).forEach(([key, value]) => {
      const processedKey = this.replacePlaceholders(key, context)
      const processedValue = this.replacePlaceholders(value, context)
      // Field names are case-insensitive.
      processedHeaders[processedKey.toLowerCase().trim()] = processedValue.trim()
    })

    // Process body without URL encoding
    let processedBody: string | undefined
    if (fetchTemplate.body) {
      const jsonEscape = processedHeaders["content-type"]?.toLowerCase() === "application/json"
      processedBody = this.replacePlaceholders(fetchTemplate.body, context, { jsonEscape })
    }

    return {
      url: processedUrl,
      headers: processedHeaders,
      body: processedBody,
      method: fetchTemplate.method,
    }
  }

  /**
   * Execute a custom integration
   */
  static async executeIntegration(
    integration: CustomIntegration,
    entry: EntryModel,
  ): Promise<{ success: boolean; error?: string }> {
    if (!integration.enabled) {
      return { success: false, error: `${integration.name} is disabled` }
    }

    try {
      // Track integration usage
      tracker.integration({
        type: "custom",
        event: "save",
      })

      // Build placeholder context
      const context = await this.buildPlaceholderContext(entry)

      if (integration.type === "url-scheme" && integration.urlSchemeTemplate) {
        // Execute URL scheme
        await URLSchemeHandler.getInstance().executeURLScheme(integration.urlSchemeTemplate, {
          title: context.title,
          url: context.url,
          content_html: context.contentHtml,
          content_markdown: context.contentMarkdown,
          summary: context.summary,
          author: context.author,
          published_at: context.publishedAt,
          description: context.description,
        })
        return { success: true }
      } else if ((integration.type === "http" || !integration.type) && integration.fetchTemplate) {
        // Execute HTTP request (existing logic)
        const { url, headers, body, method } = await this.processFetchTemplate(
          integration.fetchTemplate,
          context,
        )

        // Prepare request options for fetch adapter
        const finalHeaders = { ...headers }

        // Set content-type if not already set and we have a body
        if (
          body &&
          ["POST", "PUT", "PATCH"].includes(method) &&
          !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")
        ) {
          finalHeaders["Content-Type"] = "application/json"
        }

        // Execute the HTTP request using fetch adapter
        const response = await getFetchAdapter().fetch(url, {
          method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
          headers: finalHeaders,
          body: body && ["POST", "PUT", "PATCH"].includes(method) ? body : undefined,
        })

        // Check if request was successful
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}: ${response.statusText}`)
        }

        return { success: true }
      } else {
        // Handle backward compatibility for integrations without type field
        if (integration.fetchTemplate) {
          // Treat as HTTP integration
          const { url, headers, body, method } = await this.processFetchTemplate(
            integration.fetchTemplate,
            context,
          )

          const finalHeaders = { ...headers }
          if (
            body &&
            ["POST", "PUT", "PATCH"].includes(method) &&
            !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")
          ) {
            finalHeaders["Content-Type"] = "application/json"
          }

          const response = await getFetchAdapter().fetch(url, {
            method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
            headers: finalHeaders,
            body: body && ["POST", "PUT", "PATCH"].includes(method) ? body : undefined,
          })

          if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}: ${response.statusText}`)
          }

          return { success: true }
        }
      }

      return { success: false, error: "Invalid integration configuration" }
    } catch (error) {
      const errorMessage = (error as Error)?.message || "Unknown error"
      return { success: false, error: errorMessage }
    }
  }

  /**
   * Execute integration with toast notifications
   */
  static async executeWithToast(integration: CustomIntegration, entry: EntryModel): Promise<void> {
    const result = await this.executeIntegration(integration, entry)
    const { t } = getI18n()

    if (result.success) {
      toast.success(t("app:entry_actions.saved_to_service", { service: integration.name }), {
        duration: 3000,
      })
    } else {
      toast.error(
        t("app:entry_actions.failed_to_save_to_service", {
          service: integration.name,
          message: result.error,
        }),
        {
          duration: 3000,
        },
      )
    }
  }

  /**
   * Validate a fetch template
   */
  static validateFetchTemplate(fetchTemplate: FetchTemplate): { valid: boolean; errors: string[] } {
    const t = getI18n().t.bind(getI18n())
    const errors: string[] = []

    if (!fetchTemplate.url?.trim()) {
      errors.push(t("settings:integration.custom_integrations.validation.errors.url_required"))
    }

    if (!fetchTemplate.method) {
      errors.push(
        t("settings:integration.custom_integrations.validation.errors.http_method_required"),
      )
    }

    if (
      fetchTemplate.method &&
      !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(fetchTemplate.method)
    ) {
      errors.push(
        t("settings:integration.custom_integrations.validation.errors.invalid_http_method"),
      )
    }

    try {
      if (fetchTemplate.url) {
        new URL(fetchTemplate.url.replaceAll(/\[.*?\]/g, "https://example.com"))
      }
    } catch {
      errors.push(t("settings:integration.custom_integrations.validation.errors.invalid_url"))
    }

    return {
      valid: errors.length === 0,
      errors,
    }
  }

  /**
   * Validate a URL scheme template
   */
  static validateURLSchemeTemplate(template: URLSchemeTemplate): {
    valid: boolean
    errors: string[]
  } {
    const t = getI18n().t.bind(getI18n())
    const errors: string[] = []

    if (!template.scheme?.trim()) {
      errors.push(
        t("settings:integration.custom_integrations.validation.errors.url_scheme_required"),
      )
    }

    if (template.scheme && !template.scheme.includes("://")) {
      errors.push(
        t(
          "settings:integration.custom_integrations.validation.errors.url_scheme_protocol_required",
        ),
      )
    }

    try {
      if (template.scheme) {
        // Replace placeholders with sample values for validation
        const testScheme = template.scheme.replaceAll(/\[.*?\]/g, "test")
        new URL(testScheme)
      }
    } catch {
      errors.push(
        t("settings:integration.custom_integrations.validation.errors.invalid_url_scheme"),
      )
    }

    return {
      valid: errors.length === 0,
      errors,
    }
  }

  /**
   * Validate a custom integration
   */
  static validateCustomIntegration(integration: Partial<CustomIntegration>): {
    valid: boolean
    errors: string[]
  } {
    const t = getI18n().t.bind(getI18n())
    const errors: string[] = []

    if (!integration.name?.trim()) {
      errors.push(
        t("settings:integration.custom_integrations.validation.errors.integration_name_required"),
      )
    }

    // Type is optional for backward compatibility, default to "http"
    const integrationType = integration.type || "http"

    if (integrationType === "http") {
      if (!integration.fetchTemplate) {
        errors.push(
          t("settings:integration.custom_integrations.validation.errors.http_template_required"),
        )
      } else {
        const templateValidation = this.validateFetchTemplate(integration.fetchTemplate)
        errors.push(...templateValidation.errors)
      }
    } else if (integrationType === "url-scheme") {
      if (!integration.urlSchemeTemplate) {
        errors.push(
          t(
            "settings:integration.custom_integrations.validation.errors.url_scheme_template_required",
          ),
        )
      } else {
        const templateValidation = this.validateURLSchemeTemplate(integration.urlSchemeTemplate)
        errors.push(...templateValidation.errors)
      }
    } else {
      errors.push(
        t("settings:integration.custom_integrations.validation.errors.invalid_integration_type"),
      )
    }

    return {
      valid: errors.length === 0,
      errors,
    }
  }

  /**
   * Get template preview with sample data
   */
  static async getTemplatePreview(
    fetchTemplate: FetchTemplate,
    sampleEntry?: Partial<EntryModel>,
  ): Promise<{
    url: string
    headers: Record<string, string>
    body?: string
    method: string
  }> {
    // Create sample context
    const sampleContext: PlaceholderContext = {
      title: sampleEntry?.title || "Sample Article Title",
      url: sampleEntry?.url || "https://example.com/article",
      contentHtml: sampleEntry?.content || "<p>This is sample HTML content</p>",
      contentMarkdown: "# Sample Article\n\nThis is sample markdown content.",
      summary: "This is a sample summary of the article content.",
      author: sampleEntry?.author || "John Doe",
      publishedAt: sampleEntry?.publishedAt?.toISOString() || new Date().toISOString(),
      description: sampleEntry?.description || "Sample article description",
    }

    return this.processFetchTemplate(fetchTemplate, sampleContext)
  }

  /**
   * Get URL scheme preview with sample data
   */
  static getURLSchemePreview(
    template: URLSchemeTemplate,
    sampleEntry?: Partial<EntryModel>,
  ): string {
    // Create sample context
    const sampleData = {
      title: sampleEntry?.title || "Sample Article Title",
      url: sampleEntry?.url || "https://example.com/article",
      content_html: sampleEntry?.content || "<p>This is sample HTML content</p>",
      content_markdown: "# Sample Article\n\nThis is sample markdown content.",
      summary: "This is a sample summary of the article content.",
      author: sampleEntry?.author || "John Doe",
      published_at: sampleEntry?.publishedAt?.toISOString() || new Date().toISOString(),
      description: sampleEntry?.description || "Sample article description",
    }

    let result = template.scheme

    // Replace all placeholders with sample data
    Object.entries(sampleData).forEach(([key, value]) => {
      const placeholder = `[${key}]`
      const encodedValue = encodeURIComponent(value || "")
      result = result.replaceAll(placeholder, encodedValue)
    })

    return result
  }
}
