import { Button } from "@follow/components/ui/button/index.js"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@follow/components/ui/form/index.jsx"
import { Input } from "@follow/components/ui/input/index.js"
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipTrigger,
} from "@follow/components/ui/tooltip/index.js"
import { cn } from "@follow/utils/utils"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMemo, useState } from "react"
import { useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { z } from "zod"

import { useModalStack } from "~/components/ui/modal/stacked/hooks"
import { isSupportedLocalRssUrl } from "~/modules/local-rss/url"

import { DiscoverImport } from "./DiscoverImport"
import { FeedForm } from "./FeedForm"

interface ToolLinkProps {
  icon: string
  label: string
  onClick?: () => void
  disabled?: boolean
  tooltip?: string
}

function ToolLink({ icon, label, onClick, disabled = false, tooltip }: ToolLinkProps) {
  const button = (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors",
        "text-text-secondary hover:bg-fill-secondary hover:text-text",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
        disabled &&
          "pointer-events-none cursor-not-allowed text-text-quaternary opacity-60 hover:bg-transparent hover:text-text-quaternary",
      )}
    >
      <i className={cn(icon, "size-3.5 shrink-0")} />
      <span>{label}</span>
    </button>
  )

  if (!disabled || !tooltip) {
    return button
  }

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-not-allowed">{button}</span>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent>{tooltip}</TooltipContent>
      </TooltipPortal>
    </Tooltip>
  )
}

const createFormSchema = (invalidRssUrlMessage: string) =>
  z.object({
    url: z.string().refine(isSupportedLocalRssUrl, {
      message: invalidRssUrlMessage,
    }),
  })

type LocalDiscoverFormValues = z.infer<ReturnType<typeof createFormSchema>>

export function LocalDiscoverForm() {
  const { t } = useTranslation()
  const { present } = useModalStack()
  const [activeUrl, setActiveUrl] = useState<string | null>(null)
  const formSchema = useMemo(() => createFormSchema(t("discover.validation.invalid_rss_url")), [t])

  const form = useForm<LocalDiscoverFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      url: "",
    },
    mode: "onChange",
  })

  const onSubmit = (values: LocalDiscoverFormValues) => {
    setActiveUrl(values.url.trim())
  }

  return (
    <div className="flex w-full max-w-xl flex-col gap-4">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("discover.rss_url")}</FormLabel>
                <FormControl>
                  <Input placeholder={t("discover.enter_url")} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="center flex flex-col gap-3">
            <Button type="submit" disabled={!form.formState.isValid}>
              {t("discover.preview")}
            </Button>

            <div className="mt-5 flex items-center justify-center gap-3 text-xs">
              <ToolLink
                icon="i-focal-file-upload"
                label={t("discover.tools.import")}
                onClick={() => {
                  present({
                    title: t("discover.tools.import"),
                    content: () => <DiscoverImport />,
                    modalClassName: "max-w-2xl w-full",
                  })
                }}
              />
              <ToolLink
                icon="i-focal-web"
                label={t("discover.tools.transform")}
                disabled
                tooltip={t("discover.tools.beta_testing")}
              />
              <ToolLink
                icon="i-focal-inbox"
                label={t("discover.tools.inbox")}
                disabled
                tooltip={t("discover.tools.beta_testing")}
              />
            </div>
          </div>
        </form>
      </Form>

      {activeUrl ? (
        <div className="w-full border-t border-fill-secondary pt-4">
          <FeedForm url={activeUrl} onSuccess={() => setActiveUrl(null)} />
        </div>
      ) : null}
    </div>
  )
}
