import { Button } from "@follow/components/ui/button/index.js"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@follow/components/ui/form/index.jsx"
import { Input } from "@follow/components/ui/input/index.js"
import { LoadingCircle } from "@follow/components/ui/loading/index.jsx"
import { RootPortal } from "@follow/components/ui/portal/index.js"
import { ScrollArea } from "@follow/components/ui/scroll-area/index.js"
import { Switch } from "@follow/components/ui/switch/index.jsx"
import { FeedViewType } from "@follow/constants"
import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { useFeedByIdOrUrl } from "@follow/store/feed/hooks"
import type { FeedModel } from "@follow/store/feed/types"
import { useCategories, useSubscriptionByFeedId } from "@follow/store/subscription/hooks"
import { subscriptionSyncService } from "@follow/store/subscription/store"
import { inferSubscriptionViewFromFeed } from "@follow/store/subscription/utils"
import { whoami } from "@follow/store/user/getters"
import { useIsLoggedIn } from "@follow/store/user/hooks"
import { tracker } from "@follow/tracker"
import { cn } from "@follow/utils/utils"
import type { FeedAnalyticsModel } from "@follow-app/client-sdk"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef } from "react"
import { useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { z } from "zod"

import { Autocomplete } from "~/components/ui/auto-completion"
import { useCurrentModal, useIsInModal } from "~/components/ui/modal/stacked/hooks"
import { useI18n } from "~/hooks/common"
import { toastFetchError } from "~/lib/error-parser"
import {
  INITIAL_SUBSCRIPTION_UNREAD_COUNT,
  upsertLocalRssSubscription,
} from "~/modules/local-rss/service"
import { feed as feedQuery, useFeedQuery } from "~/queries/feed"

import { FeedSummary } from "./FeedSummary"

const formSchema = z.object({
  view: z.string(),
  category: z.string().nullable().optional(),
  isPrivate: z.boolean().optional(),
  hideFromTimeline: z.boolean().optional(),
  title: z.string().optional(),
})
export type FeedFormDataValuesType = z.infer<typeof formSchema>

const getDefaultFormValues = (): FeedFormDataValuesType => ({
  view: FeedViewType.Articles.toString(),
  isPrivate: false,
  hideFromTimeline: false,
})

export const FeedForm: Component<{
  url?: string
  id?: string
  defaultValues?: FeedFormDataValuesType

  onSuccess?: () => void
}> = ({ id: _id, defaultValues, url, onSuccess }) => {
  const queryParams = { id: _id, url }

  const feedQuery = useFeedQuery(queryParams)

  const id = feedQuery.data?.feed.id || _id
  const feed = useFeedByIdOrUrl({
    id,
    url,
  }) as FeedModel

  const { t } = useTranslation()

  const isInModal = useIsInModal()
  const isCompactLayout = LOCAL_RSS_MODE && !isInModal
  const placeholderRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!feedQuery.isLoading) {
      tracker.subscribeModalOpened({
        feedId: id,
        feedUrl: feedQuery.data?.feed.url || url,
        isError: feedQuery.isError,
      })
    }
  }, [feedQuery.data?.feed.url, feedQuery.isError, feedQuery.isLoading, id, url])

  const feedInnerFormProps = {
    defaultValues,
    id,
    url,
    onSuccess,
    isLoading: feedQuery.isLoading,
    subscriptionData: feedQuery.data?.subscription,
    feed,
    analytics: feedQuery.data?.analytics,
    placeholderRef,
    inlineActions: isCompactLayout,
  } as const

  return (
    <div
      className={cn(
        "mx-auto w-full max-w-[550px] lg:min-w-[550px]",
        isCompactLayout
          ? "flex flex-col"
          : "flex h-full max-h-[calc(100vh-300px)] min-h-[420px] flex-col",
      )}
    >
      {useMemo(() => {
        switch (true) {
          case !!feed: {
            if (isCompactLayout) {
              return <FeedInnerForm {...feedInnerFormProps} />
            }

            return (
              <ScrollArea.ScrollArea
                flex
                rootClassName={cn(isInModal && "-mx-4 px-4 -mt-4", "h-[500px] grow")}
                viewportClassName="pt-4"
              >
                {/* // Workaround for the issue with the scroll area viewport setting the display to
                table // Learn more about the issue here: //
                https://github.com/radix-ui/primitives/issues/926
                https://github.com/radix-ui/primitives/issues/3129
                https://github.com/radix-ui/primitives/pull/3225 */}
                <div className="flex">
                  <div className="w-0 grow truncate">
                    <FeedInnerForm {...feedInnerFormProps} />
                  </div>
                </div>
              </ScrollArea.ScrollArea>
            )
          }
          case feedQuery.isLoading: {
            return (
              <div
                className={cn(
                  "flex items-center justify-center",
                  isCompactLayout ? "py-8" : "flex-1",
                )}
              >
                <LoadingCircle size="large" />
              </div>
            )
          }
          case !!feedQuery.error: {
            return (
              <div className="center grow flex-col gap-3">
                <i className="i-focal-close size-7 text-red" />
                <p>{t("feed_form.error_fetching_feed")}</p>
                {feedQuery.error instanceof Error && (
                  <p className="max-w-[420px] text-center text-sm text-text-secondary">
                    {feedQuery.error.message}
                  </p>
                )}
              </div>
            )
          }
          default: {
            return (
              <div className="center h-full grow flex-col">
                <i className="i-focal-question mb-6 size-12 text-zinc-500" />
                <p>{t("feed_form.feed_not_found")}</p>
              </div>
            )
          }
        }
      }, [
        defaultValues,
        feed,
        feedQuery.data?.analytics,
        feedQuery.data?.subscription,
        feedQuery.error,
        feedQuery.isLoading,
        id,
        feedInnerFormProps,
        isCompactLayout,
        isInModal,
        onSuccess,
        t,
        url,
      ])}
      {!isCompactLayout && <div ref={placeholderRef} />}
    </div>
  )
}

const FeedInnerForm = ({
  defaultValues,
  id,

  onSuccess,
  subscriptionData,
  feed,
  analytics,

  placeholderRef,
  isLoading,
  inlineActions = false,
}: {
  defaultValues?: z.infer<typeof formSchema>
  id?: string

  onSuccess?: () => void
  subscriptionData?: {
    view?: number
    category?: string | null
    isPrivate?: boolean
    title?: string | null
    hideFromTimeline?: boolean | null
  }
  feed: FeedModel
  analytics?: FeedAnalyticsModel

  placeholderRef: React.RefObject<HTMLDivElement | null>
  isLoading: boolean
  inlineActions?: boolean
}) => {
  const subscription = useSubscriptionByFeedId(id || "") || subscriptionData
  const isSubscribed = !!subscription

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: defaultValues || getDefaultFormValues(),
  })

  const { setClickOutSideToDismiss, dismiss } = useCurrentModal()

  useEffect(() => {
    setClickOutSideToDismiss(!form.formState.isDirty)
  }, [form.formState.isDirty, setClickOutSideToDismiss])

  useEffect(() => {
    if (subscription) {
      if (!LOCAL_RSS_MODE) {
        form.setValue("view", `${subscription?.view}`)
        typeof subscription.isPrivate === "boolean" &&
          form.setValue("isPrivate", subscription.isPrivate)
        typeof subscription.hideFromTimeline === "boolean" &&
          form.setValue("hideFromTimeline", subscription.hideFromTimeline)
      }
      subscription?.category && form.setValue("category", subscription.category)
      subscription?.title && form.setValue("title", subscription.title)
    }
  }, [form, subscription])

  useEffect(() => {
    if (subscription || defaultValues?.view) return

    if (!LOCAL_RSS_MODE && typeof analytics?.view === "number") {
      form.setValue("view", `${analytics.view}`)
      return
    }

    form.setValue("view", `${inferSubscriptionViewFromFeed(feed)}`)
  }, [analytics?.view, defaultValues?.view, feed, form, subscription])

  const followMutation = useMutation({
    mutationFn: async (values: z.infer<typeof formSchema>) => {
      const userId = whoami()?.id || ""
      const body = {
        url: feed.url,
        view: Number.parseInt(values.view),
        category: values.category,
        isPrivate: values.isPrivate || false,
        hideFromTimeline: values.hideFromTimeline,
        title: values.title,
        feedId: feed.id,
        userId,
        type: "feed",
        listId: undefined,
      } as const

      if (LOCAL_RSS_MODE) {
        return upsertLocalRssSubscription({
          feed,
          subscription: body,
        })
      }

      if (isSubscribed) {
        return subscriptionSyncService.edit(body)
      } else {
        return subscriptionSyncService.subscribe(body)
      }
    },
    onSuccess: () => {
      const feedId = feed.id
      if (feedId) {
        feedQuery.byId({ id: feedId }).invalidate()
      }

      const isInitialLocalSubscription = LOCAL_RSS_MODE && !isSubscribed
      toast(isSubscribed ? t("feed_form.updated") : t("feed_form.followed"), {
        duration: isInitialLocalSubscription ? 4000 : 1000,
        description: isInitialLocalSubscription
          ? t("feed_form.initial_subscription_hint", { count: INITIAL_SUBSCRIPTION_UNREAD_COUNT })
          : undefined,
      })

      onSuccess?.()
    },
    onError(err) {
      toastFetchError(err)
    },
  })

  function onSubmit(values: z.infer<typeof formSchema>) {
    followMutation.mutate(values)
  }

  const t = useI18n()

  const isLoggedIn = useIsLoggedIn()

  const categories = useCategories()

  const suggestions = useMemo(
    () =>
      (
        categories?.map((i) => ({
          name: i,
          value: i,
        })) || []
      ).sort((a, b) => a.name.localeCompare(b.name)),
    [categories],
  )

  const fillDefaultTitle = useCallback(() => {
    form.setValue("title", feed.title || "")
  }, [feed.title, form])

  const actionButtons = (
    <div className={cn("flex items-center justify-end gap-4", inlineActions ? "pt-1" : "pt-2")}>
      {isSubscribed && (
        <Button
          disabled={!LOCAL_RSS_MODE && !isLoggedIn}
          data-testid="feed-form-cancel"
          type="button"
          variant="ghost"
          onClick={() => {
            dismiss()
          }}
        >
          {t.common("words.cancel")}
        </Button>
      )}
      <Button
        disabled={!LOCAL_RSS_MODE && !isLoggedIn}
        data-testid="feed-form-submit"
        form="feed-form"
        type="submit"
        isLoading={followMutation.isPending}
      >
        {isSubscribed ? t("feed_form.update") : t("feed_form.follow")}
      </Button>
    </div>
  )

  return (
    <div className={cn("flex flex-col", inlineActions ? "gap-y-3" : "flex-1 gap-y-4")}>
      <FeedSummary
        isLoading={isLoading}
        feed={feed}
        analytics={analytics}
        showAnalytics={!LOCAL_RSS_MODE}
      />
      <Form {...form}>
        <form
          id="feed-form"
          data-testid="feed-form"
          onSubmit={form.handleSubmit(onSubmit)}
          className={cn("flex flex-col px-1", inlineActions ? "gap-y-3" : "flex-1 gap-y-4")}
        >
          <FormField
            control={form.control}
            name="title"
            render={({ field }) => (
              <FormItem>
                <div>
                  <FormLabel>{t("feed_form.title")}</FormLabel>
                  <FormDescription>{t("feed_form.title_description")}</FormDescription>
                </div>
                <FormControl>
                  <div className="flex gap-2">
                    <Input
                      data-testid="feed-form-title-input"
                      placeholder={feed.title || undefined}
                      {...field}
                    />
                    <Button
                      buttonClassName="shrink-0"
                      type="button"
                      variant="outline"
                      onClick={fillDefaultTitle}
                      disabled={field.value === feed.title}
                    >
                      {t("feed_form.fill_default")}
                    </Button>
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="category"
            render={({ field }) => (
              <FormItem>
                <div>
                  <FormLabel>{t("feed_form.category")}</FormLabel>
                  <FormDescription>{t("feed_form.category_description")}</FormDescription>
                </div>
                <FormControl>
                  <div>
                    <Autocomplete
                      maxHeight={window.innerHeight < 600 ? 120 : 240}
                      suggestions={suggestions}
                      {...(field as any)}
                      onSuggestionSelected={(suggestion) => {
                        if (suggestion) {
                          field.onChange(suggestion.value)
                        }
                      }}
                    />
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          {!LOCAL_RSS_MODE && (
            <>
              <FormField
                control={form.control}
                name="isPrivate"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between">
                      <div>
                        <FormLabel className="flex items-center gap-1">
                          <span>{t("feed_form.private_follow")}</span>
                        </FormLabel>
                        <FormDescription>
                          {t("feed_form.private_follow_description")}
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Switch
                          className="shrink-0"
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </div>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="hideFromTimeline"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between">
                      <div>
                        <FormLabel className="flex items-center gap-1">
                          <span>{t("feed_form.hide_from_timeline")}</span>
                        </FormLabel>
                        <FormDescription>
                          {t("feed_form.hide_from_timeline_description")}
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Switch
                          className="shrink-0"
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </div>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="view"
                render={({ field }) => <input type="hidden" {...field} />}
              />
            </>
          )}
          {inlineActions ? actionButtons : null}
        </form>
      </Form>
      {!inlineActions && <RootPortal to={placeholderRef.current}>{actionButtons}</RootPortal>}
    </div>
  )
}
