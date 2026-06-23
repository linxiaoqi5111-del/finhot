import { Button } from "@follow/components/ui/button/index.js"
import type { FC } from "react"
import { useTranslation } from "react-i18next"

import { attachOpenInEditor } from "~/lib/dev"

import type { AppErrorFallbackProps } from "../common/AppErrorBoundary"
import { FeedbackIssue } from "../common/ErrorElement"
import { m } from "../common/Motion"
import { useCurrentModal } from "../ui/modal/stacked/hooks"
import { parseError } from "./helper"

const ModalErrorFallback: FC<AppErrorFallbackProps> = (props) => {
  const { message, stack } = parseError(props.error)
  const modal = useCurrentModal()
  const { t } = useTranslation()
  return (
    <m.div
      className="flex flex-col items-center justify-center rounded-md bg-theme-background p-2"
      exit={{
        opacity: 0,
        scale: 0.9,
      }}
    >
      <div className="m-auto max-w-prose text-center">
        <div className="mb-4">
          <i className="i-focal-bug text-4xl text-red-500" />
        </div>
        <div className="text-lg font-bold">{message}</div>
        {import.meta.env.DEV && stack ? (
          <pre className="mt-4 max-h-48 cursor-text select-text overflow-auto whitespace-pre-line rounded-md bg-red-50 p-4 text-left font-mono text-sm text-red-600">
            {attachOpenInEditor(stack)}
          </pre>
        ) : null}

        <p className="my-8">
          {APP_NAME} {t("modal_error.description")}
        </p>

        <div className="center gap-4">
          <Button onClick={() => modal.dismiss()} variant="outline">
            {t("modal_error.close")}
          </Button>
          <Button onClick={() => window.location.reload()} variant="outline">
            {t("modal_error.reload")}
          </Button>
        </div>

        <FeedbackIssue message={message!} stack={stack} error={props.error} />
      </div>
    </m.div>
  )
}
export default ModalErrorFallback
