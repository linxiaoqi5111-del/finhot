import { Button } from "@follow/components/ui/button/index.js"
import { LoadingWithIcon } from "@follow/components/ui/loading/index.jsx"
import * as ScrollArea from "@follow/components/ui/scroll-area/ScrollArea.js"
import {
  useActionRules,
  useIsActionDataDirty,
  usePrefetchActions,
  useUpdateActionsMutation,
} from "@follow/store/action/hooks"
import type { ActionItem } from "@follow/store/action/store"
import { actionActions } from "@follow/store/action/store"
import { nextFrame } from "@follow/utils"
import { JsonObfuscatedCodec } from "@follow/utils/json-codec"
import { cn } from "@follow/utils/utils"
import { useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useBlocker } from "react-router"
import { toast } from "sonner"

import { MenuItemText, useShowContextMenu } from "~/atoms/context-menu"
import { HeaderActionButton, HeaderActionGroup } from "~/components/ui/button/HeaderActionButton"
import { useDialog, useModalStack } from "~/components/ui/modal/stacked/hooks"
import { useContextMenu } from "~/hooks/common/useContextMenu"
import { getI18n } from "~/i18n"
import { copyToClipboard, readFromClipboard } from "~/lib/clipboard"
import { toastFetchError } from "~/lib/error-parser"
import { downloadJsonFile, selectJsonFile } from "~/lib/export"
import { RuleCard } from "~/modules/action/rule-card"
import {
  buildActionSummary,
  buildConditionSummary,
  getRuleDisplayName,
} from "~/modules/action/rule-summary"

import { useSetSubViewRightView } from "../app-layout/subview/hooks"
import { applyActionRulesToExistingEntries } from "./apply-existing-rules"
import { generateExportFilename } from "./utils"

const EmptyActionPlaceholder = () => {
  const { t } = useTranslation("settings")

  return (
    <div className="rounded-xl border border-fill-secondary bg-material-ultra-thin px-4 py-8 text-center">
      <p className="text-sm font-medium text-text-tertiary">
        {t("actions.action_card.empty.description")}
      </p>
    </div>
  )
}

export const ActionSetting = ({ toolbar = "subview" }: { toolbar?: "inline" | "subview" }) => {
  const actions = useActionRules()
  const { t } = useTranslation("settings")
  const isDirty = useIsActionDataDirty()

  const [selectedRuleIndex, setSelectedRuleIndex] = useState(0)
  const [openCompactRuleIndex, setOpenCompactRuleIndex] = useState<number | null>(null)
  const actionQuery = usePrefetchActions()
  useUnSavedBlocker(isDirty)

  useEffect(() => {
    if (actions.length === 0) {
      setSelectedRuleIndex(0)
      setOpenCompactRuleIndex(null)
      return
    }

    if (selectedRuleIndex > actions.length - 1) {
      setSelectedRuleIndex(actions.length - 1)
    }
    if (openCompactRuleIndex !== null && openCompactRuleIndex > actions.length - 1) {
      setOpenCompactRuleIndex(null)
    }
  }, [actions.length, openCompactRuleIndex, selectedRuleIndex])

  if (actionQuery.isPending) {
    return (
      <LoadingWithIcon
        className="flex h-64 items-center justify-center"
        icon={<i className="i-focal-magic-2" />}
        size="large"
      />
    )
  }

  const hasActions = actions.length > 0

  const handleCreateRule = () => {
    const nextIndex = actions.length
    actionActions.addRule((number) => t("actions.actionName", { number }))
    setSelectedRuleIndex(nextIndex)
    setOpenCompactRuleIndex(nextIndex)
  }
  return (
    <>
      <ActionButtonGroup toolbar={toolbar} onCreateRule={handleCreateRule} />
      {hasActions ? (
        <div className="flex min-h-0 w-full flex-1 flex-col @[960px]:absolute @[960px]:inset-x-0 @[960px]:bottom-0 @[960px]:top-12">
          <div className="hidden min-h-0 flex-1 @[960px]:flex @[960px]:overflow-hidden @[960px]:rounded-lg @[960px]:border @[960px]:border-fill-secondary">
            <RuleList
              selectedIndex={selectedRuleIndex}
              onSelect={setSelectedRuleIndex}
              onDelete={(deletedIndex) => {
                // Adjust selectedRuleIndex when a rule is deleted
                if (deletedIndex === selectedRuleIndex) {
                  // If deleting the selected rule, select the previous one or 0
                  setSelectedRuleIndex(Math.max(0, deletedIndex - 1))
                } else if (deletedIndex < selectedRuleIndex) {
                  // If deleting a rule before the selected one, shift the index down
                  setSelectedRuleIndex(selectedRuleIndex - 1)
                }
              }}
            />
            <div className="flex flex-1 border-l border-fill-secondary">
              <RuleCard index={selectedRuleIndex} mode="detail" />
            </div>
          </div>
          <div className="flex flex-col gap-3 @[960px]:hidden">
            {actions.map((action, actionIdx) => (
              <RuleCard
                key={action.index ?? actionIdx}
                index={actionIdx}
                mode="compact"
                defaultOpen={actionIdx === openCompactRuleIndex}
                onOpenChange={(open) => {
                  if (open) {
                    setSelectedRuleIndex(actionIdx)
                    setOpenCompactRuleIndex(actionIdx)
                  } else {
                    setOpenCompactRuleIndex((currentIndex) =>
                      currentIndex === actionIdx ? null : currentIndex,
                    )
                  }
                }}
              />
            ))}
          </div>
          <ActionSaveFooter />
        </div>
      ) : (
        <EmptyActionPlaceholder />
      )}
    </>
  )
}

const ActionShareButton = ({ variant = "button" }: { variant?: "button" | "header" }) => {
  const { t } = useTranslation("settings")
  const { present } = useModalStack()
  const actionLength = useActionRules((actions) => actions.length)
  const hasActions = actionLength > 0

  const handleExport = () => {
    try {
      const jsonData = actionActions.exportRules()
      const filename = generateExportFilename()
      downloadJsonFile(jsonData, filename)
      toast.success(t("actions.action_card.summary.export_success", { filename }))
    } catch {
      toast.error(t("actions.action_card.summary.export_failed"))
    }
  }

  const handleImport = async () => {
    try {
      const jsonData = await selectJsonFile()
      const result = actionActions.importRules(jsonData)

      if (result.success) {
        toast.success(result.message)
      } else {
        toast.error(result.message)
      }
    } catch (error) {
      if (error instanceof Error && error.message === "No file selected") {
        return
      }
      toast.error(t("actions.action_card.summary.import_failed"))
    }
  }

  const focalPrefix = "focal:actions#"
  const legacyFoloPrefix = "folo:actions#"
  const handleCopyToClipboard = useCallback(async () => {
    try {
      const jsonData = actionActions.exportRules()
      const codecData = JsonObfuscatedCodec.encode(jsonData)
      await copyToClipboard(`${focalPrefix}${codecData}`)
      toast.success(t("actions.action_card.summary.copy_success"))
    } catch (error) {
      toast.error(t("actions.action_card.summary.copy_failed"))
      console.error(error)
    }
  }, [focalPrefix])

  const handleImportFromClipboard = useCallback(async () => {
    try {
      const clipboardData = await readFromClipboard()
      let codecData: string

      if (clipboardData.startsWith(focalPrefix)) {
        codecData = clipboardData.slice(focalPrefix.length)
      } else if (clipboardData.startsWith(legacyFoloPrefix)) {
        codecData = clipboardData.slice(legacyFoloPrefix.length)
      } else {
        toast.error(t("actions.action_card.summary.invalid_clipboard"))
        return
      }

      const jsonData = JsonObfuscatedCodec.decode(codecData)
      const result = actionActions.importRules(jsonData)

      if (result.success) {
        toast.success(result.message)
      } else {
        toast.error(result.message)
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("clipboard")) {
        toast.error(error.message)
      } else {
        toast.error(t("actions.action_card.summary.import_clipboard_failed"))
      }
      console.error(error)
    }
  }, [focalPrefix, legacyFoloPrefix])

  const openShareRules = () => {
    present({
      title: t("actions.share_rules"),
      clickOutsideToDismiss: true,
      modalClassName: "w-[28rem] max-w-full",
      content: ({ dismiss }) => (
        <ActionShareModalContent
          hasActions={hasActions}
          onExport={() => {
            handleExport()
            dismiss()
          }}
          onImport={() => {
            void handleImport().then(dismiss)
          }}
          onCopy={() => {
            void handleCopyToClipboard().then(dismiss)
          }}
          onImportClipboard={() => {
            void handleImportFromClipboard().then(dismiss)
          }}
        />
      ),
    })
  }

  if (variant === "header") {
    return (
      <HeaderActionButton
        data-testid="actions-share-rules"
        variant="neutral"
        icon="i-focal-share-forward"
        onClick={openShareRules}
      >
        {t("actions.share_rules")}
      </HeaderActionButton>
    )
  }

  return (
    <Button size="sm" variant="outline" data-testid="actions-share-rules" onClick={openShareRules}>
      <i className="i-focal-share-forward mr-1 size-4" />
      {t("actions.share_rules")}
    </Button>
  )
}

const ActionShareModalContent = ({
  hasActions,
  onExport,
  onImport,
  onCopy,
  onImportClipboard,
}: {
  hasActions: boolean
  onExport: () => void
  onImport: () => void
  onCopy: () => void
  onImportClipboard: () => void
}) => {
  const { t } = useTranslation("settings")

  const items = [
    {
      icon: "i-focal-download-2",
      label: t("actions.action_card.summary.export"),
      disabled: !hasActions,
      onClick: onExport,
    },
    {
      icon: "i-focal-file-upload",
      label: t("actions.action_card.summary.import_file"),
      disabled: false,
      onClick: onImport,
    },
    {
      icon: "i-focal-copy-2",
      label: t("actions.action_card.summary.copy"),
      disabled: !hasActions,
      onClick: onCopy,
    },
    {
      icon: "i-focal-paste",
      label: t("actions.action_card.summary.import_clipboard"),
      disabled: false,
      onClick: onImportClipboard,
    },
  ]

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          disabled={item.disabled}
          className="flex w-full items-center gap-3 rounded-lg border border-fill-secondary bg-fill-quinary px-4 py-3 text-left text-sm font-medium text-text transition-colors hover:bg-fill-tertiary disabled:cursor-not-allowed disabled:opacity-50"
          onClick={item.onClick}
        >
          <i className={cn(item.icon, "size-4 text-text-secondary")} />
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  )
}

const useSaveActionsMutation = () => {
  const queryClient = useQueryClient()
  const { t } = useTranslation("settings")

  return useUpdateActionsMutation({
    onSuccess: async () => {
      await applyActionRulesToExistingEntries().catch((error) => {
        console.warn("[actions] Failed to apply rules to existing entries:", error)
      })
      queryClient.invalidateQueries({
        queryKey: ["entries"],
      })
      toast(t("actions.saveSuccess"))
    },
    onError: (error) => {
      toastFetchError(error)
    },
  })
}

const ActionSaveFooter = () => {
  const { t } = useTranslation("settings")
  const isDirty = useIsActionDataDirty()
  const mutation = useSaveActionsMutation()

  if (!isDirty && !mutation.isPending) return null

  return (
    <div className="sticky bottom-0 z-10 flex w-full shrink-0 justify-end self-stretch border-t border-fill-tertiary bg-background/95 py-4 pl-5 pr-0 backdrop-blur-background">
      <Button
        data-testid="actions-save"
        variant="primary"
        disabled={!isDirty}
        isLoading={mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {!mutation.isPending && <i className="i-focal-check-circle mr-2 size-4" />}
        {mutation.isPending ? t("actions.saving") : t("actions.save_and_apply")}
      </Button>
    </div>
  )
}

const RuleList = ({
  selectedIndex,
  onSelect,
  onDelete,
}: {
  selectedIndex: number
  onSelect: (index: number) => void
  onDelete: (index: number) => void
}) => {
  const rules = useActionRules()
  const { t } = useTranslation("settings")
  const ruleCount = useActionRules((s) => s.length)
  const mutation = useUpdateActionsMutation()
  const { ask } = useDialog()
  const showContextMenu = useShowContextMenu()

  const handleDeleteRule = useCallback(
    (index: number) => {
      if (ruleCount === 1) {
        ask({
          title: t("actions.action_card.summary.delete_title"),
          variant: "danger",
          message: t("actions.action_card.summary.delete_message"),
          onConfirm: () => {
            actionActions.deleteRule(index)
            onDelete(index)
            nextFrame(() => {
              mutation.mutate()
            })
          },
        })
      } else {
        actionActions.deleteRule(index)
        onDelete(index)
      }
    },
    [ruleCount, ask, t, mutation, onDelete],
  )

  if (rules.length === 0) {
    return null
  }

  return (
    <div className="flex w-[260px] shrink-0 flex-col">
      <ScrollArea.ScrollArea rootClassName="h-full" viewportClassName="h-full">
        <div className="flex flex-col">
          {rules.map((rule, index) => (
            <RuleListItem
              key={rule.index ?? index}
              rule={rule}
              index={index}
              isActive={index === selectedIndex}
              onSelect={onSelect}
              handleDelete={handleDeleteRule}
              showContextMenu={showContextMenu}
            />
          ))}
        </div>
      </ScrollArea.ScrollArea>
    </div>
  )
}

const RuleListItem = ({
  rule,
  index,
  isActive,
  onSelect,
  handleDelete,
  showContextMenu,
}: {
  rule: ActionItem
  index: number
  isActive: boolean
  onSelect: (index: number) => void
  handleDelete: (index: number) => void
  showContextMenu: ReturnType<typeof useShowContextMenu>
}) => {
  const { t } = useTranslation("settings")
  const displayName = getRuleDisplayName(rule, index, t)
  const whenSummary = buildConditionSummary(rule, t)
  const actionSummary = buildActionSummary(rule, t)

  const contextMenuProps = useContextMenu({
    onContextMenu: async (e) => {
      e.preventDefault()
      await showContextMenu(
        [
          new MenuItemText({
            label: t("actions.action_card.summary.delete"),
            icon: <i className="i-focal-delete-2" />,
            click: () => handleDelete(index),
            requiresLogin: true,
          }),
        ],
        e,
      )
    },
  })

  return (
    <button
      type="button"
      onClick={() => onSelect(index)}
      {...contextMenuProps}
      className={cn(
        "flex flex-col gap-1 border-b border-fill-tertiary px-4 py-3 text-left transition-all last:border-b-0",
        isActive ? "bg-fill-quaternary" : "hover:bg-fill-quinary",
      )}
    >
      <span className="text-sm font-medium text-text">{displayName}</span>
      <span className="line-clamp-2 text-xs text-text-secondary">{whenSummary}</span>
      <span className="line-clamp-1 text-xs text-text-secondary">{actionSummary}</span>
    </button>
  )
}

const ActionButtonGroup = ({
  toolbar,
  onCreateRule,
}: {
  toolbar: "inline" | "subview"
  onCreateRule: () => void
}) => {
  const { t } = useTranslation("settings")

  const setRightView = useSetSubViewRightView()
  const actions = useMemo(
    () =>
      toolbar === "inline" ? (
        <>
          <Button size="sm" variant="outline" data-testid="actions-new-rule" onClick={onCreateRule}>
            <i className="i-focal-add mr-1 size-4" />
            {t("actions.add_rule")}
          </Button>

          <ActionShareButton />
        </>
      ) : (
        <HeaderActionGroup>
          <HeaderActionButton
            data-testid="actions-new-rule"
            variant="primary"
            icon="i-focal-add"
            onClick={onCreateRule}
          >
            {t("actions.newRule")}
          </HeaderActionButton>

          <ActionShareButton variant="header" />
        </HeaderActionGroup>
      ),
    [onCreateRule, t, toolbar],
  )

  useEffect(() => {
    if (toolbar !== "subview") {
      return
    }
    setRightView(actions)
    return () => {
      setRightView(null)
    }
  }, [setRightView, actions, toolbar])

  if (toolbar === "inline") {
    return <div className="mb-4 flex justify-end gap-2">{actions}</div>
  }

  return null
}

const useUnSavedBlocker = (isDirty: boolean) => {
  const navigationBlocker = useBlocker(({ currentLocation, nextLocation }) => {
    return isDirty && currentLocation.pathname !== nextLocation.pathname
  })

  const isRouterPromptOpenRef = useRef(false)
  const { ask } = useDialog()
  useEffect(() => {
    if (navigationBlocker.state !== "blocked") {
      isRouterPromptOpenRef.current = false
      return
    }
    if (isRouterPromptOpenRef.current) {
      return
    }
    isRouterPromptOpenRef.current = true
    const { t } = getI18n()
    ask({
      title: t("common:words.unsaved_changes"),
      message: t("settings:actions.navigate.prompt"),
      variant: "ask",
      onConfirm: () => navigationBlocker.proceed(),
    })
  }, [ask, navigationBlocker])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const hasUnsavedChanges = isDirty
      if (!hasUnsavedChanges) {
        return
      }
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload)
    }
  }, [isDirty])
}
