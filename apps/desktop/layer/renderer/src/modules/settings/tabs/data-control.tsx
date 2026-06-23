import { CarbonInfinitySymbol } from "@follow/components/icons/infinify.jsx"
import { Button, MotionButtonBase } from "@follow/components/ui/button/index.js"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@follow/components/ui/form/index.js"
import { Input } from "@follow/components/ui/input/Input.js"
import { Slider } from "@follow/components/ui/slider/index.js"
import { exportDB } from "@follow/database/db"
import { ELECTRON_BUILD } from "@follow/shared/constants"
import { getFeedById } from "@follow/store/feed/getter"
import { getAllFeedSubscription } from "@follow/store/subscription/getter"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQuery } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { z } from "zod"

import { setGeneralSetting, useGeneralSettingValue } from "~/atoms/settings/general"
import { useDialog, useModalStack } from "~/components/ui/modal/stacked/hooks"
import { ipcServices } from "~/lib/client"
import { queryClient } from "~/lib/query-client"
import { clearLocalPersistStoreData } from "~/store/utils/clear"

import { SettingRow } from "../control"
import { createSetting } from "../helper/builder"
import { SettingItemGroup } from "../section"

const { SettingBuilder } = createSetting("general", useGeneralSettingValue, setGeneralSetting)

export const SettingDataControl = () => {
  const { t } = useTranslation("settings")
  const { present } = useModalStack()
  const { ask } = useDialog()

  return (
    <div className="mt-4">
      {/* Top Level - Most Important */}
      <SettingBuilder
        settings={[
          {
            type: "title",
            value: t("general.data"),
          },

          {
            type: "title",
            value: t("general.export_data.title"),
          },

          {
            label: t("general.export.label"),
            description: t("general.export.description"),
            buttonText: t("general.export.button"),
            action: () => {
              present({
                title: t("general.export.label"),
                clickOutsideToDismiss: true,
                modalClassName: "w-[30rem] max-w-full",
                content: () => <ExportFeedsForm />,
              })
            },
          },
          {
            label: t("general.export_database.label"),
            description: t("general.export_database.description"),
            buttonText: t("general.export_database.button"),
            action: () => {
              exportDB()
            },
          },

          {
            type: "title",
            value: t("general.maintenance.title"),
          },
          ELECTRON_BUILD ? CleanElectronCache : CleanCacheStorage,
          ELECTRON_BUILD && AppCacheLimit,
          {
            label: t("general.rebuild_database.label"),
            action: () => {
              ask({
                title: t("general.rebuild_database.title"),
                variant: "danger",
                message: `${t("general.rebuild_database.warning.line1")}\n${t("general.rebuild_database.warning.line2")}`,
                confirmText: t("ok", { ns: "common" }),
                onConfirm: async () => {
                  await clearLocalPersistStoreData()
                  window.location.reload()
                },
              })
            },
            description: t("general.rebuild_database.description"),
            buttonText: t("general.rebuild_database.button"),
          },
          ELECTRON_BUILD && {
            label: t("general.log_file.label"),
            description: t("general.log_file.description"),
            buttonText: t("general.log_file.button"),
            action: () => {
              ipcServices?.app.revealLogFile?.()
            },
          },
        ]}
      />
    </div>
  )
}

const exportFeedFormSchema = z.object({
  rsshubUrl: z.string().url().optional().or(z.literal("")),
})

const escapeXmlAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")

const RSSHUB_DEFAULT_INSTANCE = "https://rsshub.app"

/**
 * Resolve the feed URL to write into the exported OPML.
 *
 * Non-RSSHub feeds keep their exact original source URL. RSSHub feeds are
 * stored internally in the canonical `rsshub://route` form, which is not a
 * real, subscribable URL, so we expand it to a public instance (rsshub.app by
 * default) so the exported OPML stays portable to other readers. Users can
 * point the export at a self-hosted instance by providing a RSSHub base URL.
 */
const resolveExportUrl = (url: string, rsshubUrl?: string) => {
  if (url.startsWith("rsshub://")) {
    const base = (rsshubUrl || RSSHUB_DEFAULT_INSTANCE).replace(/\/+$/, "")
    const route = url.slice("rsshub://".length)
    return `${base}/${route}`
  }
  return url
}

const makeFeedOutline = (
  {
    title,
    xmlUrl,
    htmlUrl,
  }: {
    title: string
    xmlUrl: string
    htmlUrl?: string | null
  },
  indent: string,
) =>
  `${indent}<outline type="rss" text="${escapeXmlAttribute(title)}" title="${escapeXmlAttribute(
    title,
  )}" xmlUrl="${escapeXmlAttribute(xmlUrl)}"${
    htmlUrl ? ` htmlUrl="${escapeXmlAttribute(htmlUrl)}"` : ""
  } />`

/**
 * Build an OPML backup from the local subscription store.
 *
 * Feeds keep their user-assigned categories as OPML folders (lossless backup);
 * uncategorized feeds are placed directly at the body root.
 */
const buildOpml = (rsshubUrl?: string) => {
  const subscriptions = getAllFeedSubscription().filter(
    (subscription) => subscription?.type === "feed" && !!subscription.feedId,
  )

  const categorized = new Map<string, string[]>()
  const uncategorized: string[] = []
  let feedCount = 0

  for (const subscription of subscriptions) {
    if (!subscription?.feedId) continue
    const feed = getFeedById(subscription.feedId)
    if (!feed?.url) continue

    const feedInfo = {
      title: subscription.title || feed.title || feed.url,
      xmlUrl: resolveExportUrl(feed.url, rsshubUrl),
      htmlUrl: feed.siteUrl,
    }

    const { category } = subscription
    if (category) {
      const existing = categorized.get(category)
      const outline = makeFeedOutline(feedInfo, "      ")
      if (existing) {
        existing.push(outline)
      } else {
        categorized.set(category, [outline])
      }
    } else {
      uncategorized.push(makeFeedOutline(feedInfo, "    "))
    }
    feedCount += 1
  }

  const body = [
    ...Array.from(categorized.entries()).map(
      ([category, outlines]) =>
        `    <outline text="${escapeXmlAttribute(category)}" title="${escapeXmlAttribute(
          category,
        )}">\n${outlines.join("\n")}\n    </outline>`,
    ),
    ...uncategorized,
  ].join("\n")

  return {
    content: `<?xml version="1.0" encoding="utf-8"?>
<opml version="2.0">
  <head>
    <title>Forge Export</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${body}
  </body>
</opml>
`,
    feedCount,
  }
}

const ExportFeedsForm = () => {
  const { t } = useTranslation("settings")

  const form = useForm<z.infer<typeof exportFeedFormSchema>>({
    resolver: zodResolver(exportFeedFormSchema),
    defaultValues: {
      rsshubUrl: "",
    },
  })

  function onSubmit(values: z.infer<typeof exportFeedFormSchema>) {
    const { content, feedCount } = buildOpml(values.rsshubUrl || undefined)

    if (feedCount === 0) {
      toast.error(t("general.export.empty"))
      return
    }

    const blob = new Blob([content], { type: "text/x-opml;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = "forge.opml"
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 text-sm">
        <FormField
          control={form.control}
          name="rsshubUrl"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("general.export.rsshub_url.label")}</FormLabel>
              <FormControl>
                <Input type="url" placeholder="https://rsshub.app" {...field} />
              </FormControl>
              <FormDescription>{t("general.export.rsshub_url.description")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex justify-end">
          <Button type="submit">{t("ok", { ns: "common" })}</Button>
        </div>
      </form>
    </Form>
  )
}

/**
 * @description clean web app service worker cache
 */
const CleanCacheStorage = () => {
  const { t } = useTranslation("settings")

  return (
    <SettingItemGroup>
      <SettingRow
        label={t("data_control.clean_cache.button")}
        description={t("data_control.clean_cache.description_web")}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const keys = await caches.keys()
            return Promise.all(
              keys.map((key) => {
                if (key.startsWith("workbox-precache-")) return null
                return caches.delete(key)
              }),
            ).then(() => {
              toast.success(t("data_control.clean_cache.success"))
            })
          }}
        >
          {t("data_control.clean_cache.button")}
        </Button>
      </SettingRow>
    </SettingItemGroup>
  )
}

const CleanElectronCache = () => {
  const { t } = useTranslation("settings")

  return (
    <SettingItemGroup>
      <SettingRow
        label={t("data_control.clean_cache.button")}
        description={t("data_control.clean_cache.description")}
      >
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              await ipcServices?.app.clearCache?.()
              queryClient.setQueryData(["app", "cache", "size"], 0)
            }}
          >
            {t("data_control.clean_cache.button")}
          </Button>
          <MotionButtonBase
            onClick={() => {
              ipcServices?.app.openCacheFolder?.()
            }}
            className="center flex size-8 rounded-md text-text-secondary transition-colors hover:bg-fill-secondary hover:text-text"
          >
            <i className="i-focal-folder-open" />
          </MotionButtonBase>
        </div>
      </SettingRow>
    </SettingItemGroup>
  )
}
const AppCacheLimit = () => {
  const { t } = useTranslation("settings")
  const { data: cacheSize, isLoading: isLoadingCacheSize } = useQuery({
    queryKey: ["app", "cache", "size"],
    queryFn: async () => {
      const byteSize = (await ipcServices?.app.getCacheSize?.()) ?? 0
      return Math.round(byteSize / 1024 / 1024)
    },
    refetchOnMount: "always",
  })
  const {
    data: cacheLimit,
    isLoading: isLoadingCacheLimit,
    refetch: refetchCacheLimit,
  } = useQuery({
    queryKey: ["app", "cache", "limit"],
    queryFn: async () => {
      const size = (await ipcServices?.app.getCacheLimit?.()) ?? 0
      return size
    },
  })

  const onChange = (value: number[]) => {
    ipcServices?.app.limitCacheSize?.(value[0]!)
    refetchCacheLimit()
  }

  if (isLoadingCacheSize || isLoadingCacheLimit) return null

  const InfinitySymbol = <CarbonInfinitySymbol />
  return (
    <SettingItemGroup>
      <SettingRow
        label={
          <>
            {t("data_control.app_cache_limit.label")}
            <span className="center ml-2 inline-flex shrink-0 gap-1 text-xs font-normal text-text-tertiary">
              <span>({cacheSize}M</span>
              <span>/</span>
              <span className="center inline-flex shrink-0">
                {cacheLimit ? <span>{cacheLimit}M</span> : InfinitySymbol}
                <span>)</span>
              </span>
            </span>
          </>
        }
        description={t("data_control.app_cache_limit.description")}
      >
        <div className="relative w-48">
          <Slider
            min={0}
            max={500}
            step={100}
            defaultValue={[cacheLimit ?? 0]}
            onValueCommit={onChange}
          />
          <div className="absolute top-5 text-base opacity-50">{InfinitySymbol}</div>
          <div className="absolute right-0 top-5 text-xs opacity-50">500M</div>
        </div>
      </SettingRow>
    </SettingItemGroup>
  )
}
