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
import { SegmentGroup, SegmentItem } from "@follow/components/ui/segment/index.js"
import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import type { DiscoveryItem } from "@follow-app/client-sdk"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation } from "@tanstack/react-query"
import { atom, useAtomValue, useStore } from "jotai"
import type { ChangeEvent } from "react"
import { useCallback, useMemo, useState } from "react"
import { useForm } from "react-hook-form"
import { Trans, useTranslation } from "react-i18next"
import { Link } from "react-router"
import { z } from "zod"

import { useModalStack } from "~/components/ui/modal/stacked/hooks"
import { followClient } from "~/lib/api-client"
import { isSupportedLocalRssUrl } from "~/modules/local-rss/url"

import { DiscoverFeedCard } from "../discover/DiscoverFeedCard"
import { FeedForm } from "../discover/FeedForm"

const createFormSchema = (invalidRssUrlMessage: string) =>
  z
    .object({
      keyword: z.string().min(1),
      type: z.enum(["search", "rss", "rsshub"]),
    })
    .superRefine((values, context) => {
      if (values.type === "rss" && !isSupportedLocalRssUrl(values.keyword)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["keyword"],
          message: invalidRssUrlMessage,
        })
      }
    })

type DiscoverFormValues = z.infer<ReturnType<typeof createFormSchema>>

const typeConfig = {
  search: {
    label: "discover.any_url_or_keyword",
    placeholderKey: "discover.input_placeholder",
    prefix: [] as string[],
    default: undefined,
  },
  rss: {
    label: "discover.rss_url",
    placeholderKey: "discover.enter_url",
    prefix: [] as string[],
    default: undefined,
  },
  rsshub: {
    label: "discover.rss_hub_route",
    placeholder: "rsshub://github/issue/follow/follow",
    prefix: ["rsshub://"],
    default: "rsshub://",
  },
} as const

type DiscoverType = keyof typeof typeConfig

const isDiscoverType = (value: string): value is DiscoverType => value in typeConfig

export function SimpleDiscoverModal({ dismiss }: { dismiss: () => void }) {
  const { t } = useTranslation(["app", "common"])
  const { present } = useModalStack()
  const jotaiStore = useStore()
  const formSchema = useMemo(() => createFormSchema(t("discover.validation.invalid_rss_url")), [t])

  const form = useForm<DiscoverFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      keyword: "",
      type: LOCAL_RSS_MODE ? "rss" : "search",
    },
    mode: "all",
  })

  const watchedType = form.watch("type")
  const currentConfig = typeConfig[watchedType]

  const discoverSearchDataAtom = useState(() => atom<DiscoveryItem[]>())[0]
  const discoverSearchData = useAtomValue(discoverSearchDataAtom)

  const mutation = useMutation({
    mutationFn: async ({ keyword, type }: { keyword: string; type: string }) => {
      // For RSS/RSSHub, show feed form modal
      if (type === "rss" || type === "rsshub") {
        present({
          title: t("feed_form.add_feed"),
          content: ({ dismiss: dismissFeedForm }) => (
            <FeedForm
              url={keyword}
              onSuccess={() => {
                dismissFeedForm()
                dismiss()
              }}
            />
          ),
        })
        return []
      }

      const { data } = await followClient.api.discover.discover({
        keyword: keyword.trim(),
        target: "feeds",
      })

      jotaiStore.set(discoverSearchDataAtom, data)
      return data
    },
  })

  const handleKeywordChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const trimmedKeyword = event.target.value.trimStart()
      const { prefix } = currentConfig

      if (!prefix || prefix.length === 0) {
        form.setValue("keyword", trimmedKeyword, { shouldValidate: true })
        return
      }

      const isValidPrefix = prefix.find((p) => trimmedKeyword.startsWith(p))
      if (!isValidPrefix) {
        form.setValue("keyword", prefix[0]!)
        return
      }

      if (trimmedKeyword.startsWith(`${isValidPrefix}${isValidPrefix}`)) {
        form.setValue("keyword", trimmedKeyword.slice(isValidPrefix.length))
        return
      }

      form.setValue("keyword", trimmedKeyword)
    },
    [form, currentConfig],
  )

  const handleTypeChange = useCallback(
    (value: string) => {
      if (!isDiscoverType(value)) return

      form.setValue("type", value)
      const newConfig = typeConfig[value]
      if (newConfig.default) {
        form.setValue("keyword", newConfig.default, { shouldValidate: true })
      } else {
        form.setValue("keyword", "", { shouldValidate: true })
      }
    },
    [form],
  )

  function onSubmit(values: DiscoverFormValues) {
    mutation.mutate(values)
  }

  return (
    <div className="flex min-h-[400px] w-[600px] flex-col">
      <div className="mb-6">
        <p className="text-sm text-text-secondary">{t("discover.find_feeds_description")}</p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {/* Type Selector */}
          <FormField
            control={form.control}
            name="type"
            render={({ field }) => (
              <FormItem className="relative">
                <FormControl>
                  <SegmentGroup value={field.value} onValueChanged={handleTypeChange}>
                    {!LOCAL_RSS_MODE && <SegmentItem value="search" label={t("words.search")} />}
                    <SegmentItem value="rss" label={t("words.rss")} />
                    {!LOCAL_RSS_MODE && <SegmentItem value="rsshub" label={t("words.rsshub")} />}
                  </SegmentGroup>
                </FormControl>
                {!LOCAL_RSS_MODE && (
                  <div className="absolute bottom-0 right-0 flex flex-col flex-wrap items-end gap-1 text-sm text-text-secondary">
                    <p>
                      <Trans
                        i18nKey="discover.find_more_in_full_page"
                        ns="app"
                        components={{
                          DiscoverLink: (
                            <Link
                              className="inline-flex items-center gap-1 text-accent underline"
                              to="/discover"
                              onClick={dismiss}
                            >
                              {t("words.discover")}
                              <i className="i-focal-arrow-right-up" />
                            </Link>
                          ),
                        }}
                      />
                    </p>
                  </div>
                )}
              </FormItem>
            )}
          />

          {/* Input Field */}
          <FormField
            control={form.control}
            name="keyword"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t(currentConfig.label)}</FormLabel>
                <FormControl>
                  <Input
                    placeholder={
                      "placeholderKey" in currentConfig
                        ? t(currentConfig.placeholderKey)
                        : currentConfig.placeholder
                    }
                    {...field}
                    onChange={handleKeywordChange}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Action Buttons */}
          <div className="flex items-center justify-end gap-3">
            <Button type="button" variant="outline" onClick={dismiss}>
              {t("words.cancel", { ns: "common" })}
            </Button>
            <Button type="submit" disabled={mutation.isPending || !form.formState.isValid}>
              {mutation.isPending
                ? t("words.searching", { ns: "common" })
                : watchedType === "rss" || watchedType === "rsshub"
                  ? t("discover.preview")
                  : t("words.search")}
            </Button>
          </div>
        </form>
      </Form>

      {/* Search Results */}
      {discoverSearchData && discoverSearchData.length > 0 && (
        <div className="mt-6 flex-1">
          <div className="mb-4 border-b border-border pb-2">
            <h3 className="font-medium text-text">
              {t("discover.search_results")} ({discoverSearchData.length})
            </h3>
          </div>
          <div className="max-h-[300px] space-y-3 overflow-y-auto">
            {discoverSearchData.map((item) => (
              <DiscoverFeedCard
                key={
                  item.feed?.id ||
                  item.list?.id ||
                  item.feed?.url ||
                  item.feed?.title ||
                  item.list?.title ||
                  item.docs
                }
                item={item}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {mutation.isSuccess && discoverSearchData && discoverSearchData.length === 0 && (
        <div className="mt-6 flex flex-1 items-center justify-center">
          <div className="text-center text-text-secondary">
            <i className="i-focal-search-3 mb-2 text-2xl" />
            <p>{t("discover.no_results")}</p>
          </div>
        </div>
      )}
    </div>
  )
}
