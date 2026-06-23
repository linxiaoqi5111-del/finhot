import { useMobile } from "@follow/components/hooks/useMobile.js"
import { Button } from "@follow/components/ui/button/index.js"
import { LoadingCircle } from "@follow/components/ui/loading/index.js"
import { ResponsiveSelect } from "@follow/components/ui/select/responsive.js"
import { useIsDark, useThemeAtomValue } from "@follow/hooks"
import { ELECTRON_BUILD, IN_ELECTRON } from "@follow/shared/constants"
import { capitalizeFirstLetter, getOS } from "@follow/utils/utils"
import { useForceUpdate } from "motion/react"
import { lazy, Suspense, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { bundledThemesInfo } from "shiki/themes"

import {
  getUISettings,
  setUISetting,
  useUISettingKey,
  useUISettingSelector,
  useUISettingValue,
} from "~/atoms/settings/ui"
import { useCurrentModal, useModalStack } from "~/components/ui/modal/stacked/hooks"
import { useSetTheme } from "~/hooks/common"
import { useShowCustomizeToolbarModal } from "~/modules/customize-toolbar/modal"

import { SETTING_MODAL_ID } from "../constants"
import { SettingActionItem, SettingRow, SettingTabbedSegment } from "../control"
import { createDefineSettingItem } from "../helper/builder"
import { createSettingBuilder } from "../helper/setting-builder"
import {
  useWrapEnhancedSettingItem,
  WrapEnhancedSettingTab,
} from "../hooks/useWrapEnhancedSettingItem"
import { SettingItemGroup } from "../section"
import { ContentFontSelector, UIFontSelector } from "../sections/fonts"

const SettingBuilder = createSettingBuilder(useUISettingValue)
const _defineItem = createDefineSettingItem("ui", useUISettingValue, setUISetting)

export const SettingAppearance = () => {
  const { t } = useTranslation("settings")
  const isMobile = useMobile()
  const defineItem = useWrapEnhancedSettingItem(_defineItem, WrapEnhancedSettingTab.Appearance)
  return (
    <div className="mt-4">
      <SettingBuilder
        settings={[
          {
            type: "title",
            value: t("appearance.common.title"),
          },

          // Top Level - Most Common
          AppThemeSegment,
          GlobalFontSize,
          UIFontSelector,
          ContentLineHeight,

          {
            type: "title",
            value: t("appearance.subscription_list.title"),
          },

          defineItem("sidebarShowUnreadCount", {
            label: t("appearance.unread_count.sidebar.title"),
            description: t("appearance.unread_count.sidebar.description"),
          }),
          {
            type: "title",
            value: t("appearance.reading_view.title"),
          },

          {
            type: "title",
            value: t("appearance.interface_window.title"),
          },

          defineItem("modalOverlay", {
            label: t("appearance.modal_overlay.label"),
            description: t("appearance.modal_overlay.description"),
            hide: isMobile,
          }),

          defineItem("reduceMotion", {
            label: t("appearance.reduce_motion.label"),
            description: t("appearance.reduce_motion.description"),
          }),

          defineItem("usePointerCursor", {
            label: t("appearance.use_pointer_cursor.label"),
            description: t("appearance.use_pointer_cursor.description"),
            hide: isMobile,
          }),

          {
            type: "title",
            value: t("appearance.system_integration.title"),
          },

          defineItem("showDockBadge", {
            label: t("appearance.unread_count.badge.label"),
            description: t("appearance.unread_count.badge.description"),
            hide: !IN_ELECTRON || !["macOS", "Linux"].includes(getOS()) || isMobile,
          }),

          {
            type: "title",
            value: t("appearance.typography.title"),
          },

          ContentFontSelector,

          {
            type: "title",
            value: t("appearance.content_display.title"),
          },

          defineItem("readerRenderInlineStyle", {
            label: t("appearance.reader_render_inline_style.label"),
            description: t("appearance.reader_render_inline_style.description"),
          }),

          {
            type: "title",
            value: t("appearance.code_highlighting.title"),
          },

          ShikiTheme,

          defineItem("guessCodeLanguage", {
            label: t("appearance.guess_code_language.label"),
            hide: !ELECTRON_BUILD,
            description: t("appearance.guess_code_language.description"),
          }),

          {
            type: "title",
            value: t("appearance.customization.title"),
          },

          CustomCSS,
          CustomizeToolbar,
        ]}
      />
    </div>
  )
}

const ShikiTheme = () => {
  const { t } = useTranslation("settings")
  const isMobile = useMobile()
  const isDark = useIsDark()
  const codeHighlightThemeLight = useUISettingKey("codeHighlightThemeLight")
  const codeHighlightThemeDark = useUISettingKey("codeHighlightThemeDark")

  return (
    <SettingItemGroup>
      <SettingRow
        label={t("appearance.code_highlight_theme.label")}
        description={t("appearance.code_highlight_theme.description")}
      >
        <ResponsiveSelect
          items={bundledThemesInfo
            .filter((theme) => theme.type === (isDark ? "dark" : "light"))
            .map((theme) => ({ value: theme.id, label: theme.displayName }))}
          value={isDark ? codeHighlightThemeDark : codeHighlightThemeLight}
          onValueChange={(value) => {
            if (isDark) {
              setUISetting("codeHighlightThemeDark", value)
            } else {
              setUISetting("codeHighlightThemeLight", value)
            }
          }}
          triggerClassName="w-48 shrink-0"
          renderItem={(item) =>
            isMobile ? (
              capitalizeFirstLetter(item.label)
            ) : (
              <span className="capitalize">{item.label}</span>
            )
          }
          size="sm"
        />
      </SettingRow>
    </SettingItemGroup>
  )
}

const textSizeMap = {
  smaller: 15,
  default: 16,
  medium: 18,
  large: 20,
}

export const TextSize = () => {
  const { t } = useTranslation("settings")
  const uiTextSize = useUISettingSelector((state) => state.uiTextSize)

  return (
    <div className="mb-3 flex items-center justify-between">
      <span className="shrink-0 text-sm font-medium">{t("appearance.text_size.label")}</span>
      <ResponsiveSelect
        defaultValue={textSizeMap.default.toString()}
        value={uiTextSize.toString() || textSizeMap.default.toString()}
        onValueChange={(value) => {
          setUISetting("uiTextSize", Number.parseInt(value) || textSizeMap.default)
        }}
        size="sm"
        triggerClassName="w-48 capitalize"
        items={Object.entries(textSizeMap).map(([size, value]) => ({
          label: t(`appearance.text_size.${size as keyof typeof textSizeMap}`),
          value: value.toString(),
        }))}
      />
    </div>
  )
}

// Global Font Size component that combines UI and content font size
const GlobalFontSize = () => {
  const { t } = useTranslation("settings")
  const uiTextSize = useUISettingSelector((state) => state.uiTextSize)

  return (
    <SettingItemGroup>
      <SettingRow
        label={t("appearance.global_font_size.label")}
        description={t("appearance.global_font_size.description")}
      >
        <ResponsiveSelect
          defaultValue={textSizeMap.default.toString()}
          value={uiTextSize.toString() || textSizeMap.default.toString()}
          onValueChange={(value) => {
            const size = Number.parseInt(value) || textSizeMap.default
            setUISetting("uiTextSize", size)
            setUISetting("contentFontSize", size)
          }}
          size="sm"
          triggerClassName="w-48 shrink-0 capitalize"
          items={Object.entries(textSizeMap).map(([size, value]) => ({
            label: t(`appearance.text_size.${size as keyof typeof textSizeMap}`),
            value: value.toString(),
          }))}
        />
      </SettingRow>
    </SettingItemGroup>
  )
}

export const AppThemeSegment = () => {
  const { t } = useTranslation("settings")
  const theme = useThemeAtomValue()
  const setTheme = useSetTheme()

  return (
    <SettingItemGroup>
      <SettingTabbedSegment
        key="theme"
        label={t("appearance.theme.label")}
        description={t("appearance.theme.description")}
        value={theme}
        values={[
          {
            value: "system",
            label: t("appearance.theme.system"),
            icon: <i className="i-focal-monitor" />,
          },
          {
            value: "light",
            label: t("appearance.theme.light"),
            icon: <i className="i-focal-sun" />,
          },
          {
            value: "dark",
            label: t("appearance.theme.dark"),
            icon: <i className="i-focal-moon" />,
          },
        ]}
        onValueChanged={(value) => {
          setTheme(value as "light" | "dark" | "system")
        }}
      />
    </SettingItemGroup>
  )
}

const CustomCSS = () => {
  const { t } = useTranslation("settings")
  const { present } = useModalStack()
  return (
    <>
      <SettingActionItem
        label={t("appearance.custom_css.label")}
        description={t("appearance.custom_css.description")}
        action={() => {
          present({
            title: t("appearance.custom_css.label"),
            content: CustomCSSModal,
            clickOutsideToDismiss: false,
            overlay: false,
            resizeable: true,
            resizeDefaultSize: {
              width: 700,
              height: window.innerHeight - 200,
            },
          })
        }}
        buttonText={t("appearance.custom_css.button")}
      />
    </>
  )
}
const LazyCSSEditor = lazy(() =>
  import("../../editor/css-editor").then((m) => ({ default: m.CSSEditor })),
)

const CustomCSSModal = () => {
  const initialCSS = useRef(getUISettings().customCSS)
  const { t } = useTranslation("common")
  const { dismiss } = useCurrentModal()
  useEffect(() => {
    return () => {
      setUISetting("customCSS", initialCSS.current)
    }
  }, [])
  useEffect(() => {
    const modal = document.querySelector(`#${SETTING_MODAL_ID}`) as HTMLDivElement
    if (!modal) return
    const prevOverlay = getUISettings().modalOverlay
    setUISetting("modalOverlay", false)

    modal.style.display = "none"
    return () => {
      setUISetting("modalOverlay", prevOverlay)

      modal.style.display = ""
    }
  }, [])
  const [forceUpdate, key] = useForceUpdate()
  return (
    <form
      className="relative flex h-full max-w-full flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        if (initialCSS.current !== getUISettings().customCSS) {
          initialCSS.current = getUISettings().customCSS
        }
        dismiss()
      }}
    >
      <Suspense
        fallback={
          <div className="center flex grow lg:h-0">
            <LoadingCircle size="large" />
          </div>
        }
      >
        <LazyCSSEditor
          defaultValue={initialCSS.current}
          key={key}
          className="h-[70vh] grow rounded-lg border p-3 font-mono lg:h-0"
          onChange={(value) => {
            setUISetting("customCSS", value)
          }}
        />
      </Suspense>

      <div className="mt-2 flex shrink-0 justify-end gap-2">
        <Button
          variant="outline"
          onClick={(e) => {
            e.preventDefault()

            setUISetting("customCSS", initialCSS.current)

            forceUpdate()
          }}
        >
          {t("words.reset")}
        </Button>
        <Button type="submit">{t("words.save")}</Button>
      </div>
    </form>
  )
}

const ContentLineHeight = () => {
  const { t } = useTranslation("settings")
  const contentLineHeight = useUISettingKey("contentLineHeight")
  return (
    <SettingItemGroup>
      <SettingRow
        label={t("appearance.content_line_height.label")}
        description={t("appearance.content_line_height.description")}
      >
        <ResponsiveSelect
          items={[
            { value: "1.25", label: t("appearance.content_line_height.tight") },
            { value: "1.375", label: t("appearance.content_line_height.snug") },
            { value: "1.5", label: t("appearance.content_line_height.normal") },
            { value: "1.75", label: t("appearance.content_line_height.relaxed") },
            { value: "2", label: t("appearance.content_line_height.loose") },
          ]}
          value={contentLineHeight.toString()}
          onValueChange={(value) => {
            setUISetting("contentLineHeight", Number.parseFloat(value))
          }}
          triggerClassName="w-48 shrink-0"
          size="sm"
        />
      </SettingRow>
    </SettingItemGroup>
  )
}

/**
 * @description customize the toolbar actions
 */
const CustomizeToolbar = () => {
  const { t } = useTranslation("settings")
  const showModal = useShowCustomizeToolbarModal()

  return (
    <SettingItemGroup>
      <SettingActionItem
        label={t("appearance.customize_toolbar.label")}
        description={t("appearance.customize_toolbar.description")}
        action={async () => {
          showModal()
        }}
        buttonText={t("appearance.words.customize")}
      />
    </SettingItemGroup>
  )
}
