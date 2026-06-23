import { Button } from "@follow/components/ui/button/index.js"
import { useTranslation } from "react-i18next"

import type { FallbackRender } from "~/components/common/ErrorBoundary"
import { attachOpenInEditor } from "~/lib/dev"

import { FeedbackIssue } from "../../../../components/common/ErrorElement"
import { parseError } from "../../../../components/errors/helper"

export const AIErrorFallback: FallbackRender = (props) => {
  const { t } = useTranslation("ai")
  const { message, stack } = parseError(props.error)

  return (
    <div className="absolute inset-0 mx-auto flex max-w-2xl flex-col items-center justify-center rounded-lg bg-theme-background p-8 shadow-sm">
      <div className="text-center">
        {/* AI-specific icon */}
        <div className="mb-6">
          <i className="i-focal-ai text-5xl text-orange" />
        </div>

        {/* Error title */}
        <h2 className="mb-3 text-xl font-semibold text-text">{t("error_fallback.title")}</h2>

        {/* Error message */}
        <div className="mb-6 text-sm leading-relaxed text-text-secondary">
          {message || t("error_fallback.description")}
        </div>

        {/* Development stack trace */}
        {import.meta.env.DEV && stack ? (
          <details className="mb-6 text-left">
            <summary className="mb-2 cursor-pointer text-xs text-text-tertiary hover:text-text-secondary">
              {t("error_fallback.show_details")}
            </summary>
            <pre className="max-h-32 cursor-text select-text overflow-auto whitespace-pre-wrap rounded-md border border-border/40 bg-fill p-3 font-mono text-xs text-text-secondary">
              {attachOpenInEditor(stack)}
            </pre>
          </details>
        ) : null}

        {/* Error description */}
        <p className="mb-8 text-sm leading-relaxed text-text-tertiary">
          {t("error_fallback.recovery_hint")}
        </p>

        {/* Action buttons */}
        <div className="flex items-center justify-center gap-3">
          <Button onClick={() => props.resetError()} variant="primary">
            {t("error_fallback.try_again")}
          </Button>

          <Button onClick={() => window.location.reload()} variant="outline">
            {t("error_fallback.reload_page")}
          </Button>
        </div>

        {/* Feedback component */}
        <div className="mt-8 border-t border-border/40 pt-6">
          <FeedbackIssue
            message={message || t("error_fallback.feedback_message")}
            stack={stack}
            error={props.error}
          />
        </div>
      </div>
    </div>
  )
}
