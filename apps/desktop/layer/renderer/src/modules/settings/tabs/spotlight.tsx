import { Button } from "@follow/components/ui/button/index.js"
import { Input } from "@follow/components/ui/input/index.js"
import { Label } from "@follow/components/ui/label/index.jsx"
import { SegmentGroup, SegmentItem } from "@follow/components/ui/segment/index.jsx"
import { Switch } from "@follow/components/ui/switch/index.jsx"
import type { SpotlightColorPreset, SpotlightRule } from "@follow/shared/spotlight"
import { defaultSpotlightColor, getSpotlightColorChoices } from "@follow/shared/spotlight"
import { validateSpotlightPattern } from "@follow/utils/spotlight"
import { nanoid } from "nanoid"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { setSpotlightSetting, useSpotlightSettingKey } from "~/atoms/settings/spotlight"

import { SettingDescription } from "../control"

const createSpotlightRule = (): SpotlightRule => ({
  id: nanoid(),
  enabled: true,
  pattern: "",
  patternType: "keyword",
  caseSensitive: false,
  color: defaultSpotlightColor,
})

const updateRuleAtIndex = (
  rules: SpotlightRule[],
  index: number,
  updater: (rule: SpotlightRule) => SpotlightRule,
) => {
  setSpotlightSetting(
    "spotlights",
    rules.map((rule, currentIndex) => (currentIndex === index ? updater(rule) : rule)),
  )
}

const deleteRuleAtIndex = (rules: SpotlightRule[], index: number) => {
  setSpotlightSetting(
    "spotlights",
    rules.filter((_, currentIndex) => currentIndex !== index),
  )
}

export const SettingSpotlight = () => {
  const { t } = useTranslation("settings")
  const rules = useSpotlightSettingKey("spotlights")
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null)

  return (
    <div className="mt-4 space-y-4">
      <SettingDescription className="max-w-none">{t("spotlight.description")}</SettingDescription>

      <div className="flex items-center justify-between gap-4">
        <div className="text-sm font-medium text-text-tertiary">
          {t("spotlight.rule_count", { count: rules.length })}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const rule = createSpotlightRule()
            setSpotlightSetting("spotlights", [...rules, rule])
            setEditingRuleId(rule.id)
          }}
        >
          <i className="i-focal-add mr-1 size-4" />
          {t("spotlight.add_rule")}
        </Button>
      </div>

      <div className="space-y-3">
        {rules.length === 0 ? (
          <div className="rounded-xl border border-fill-secondary bg-material-ultra-thin px-4 py-8 text-center text-sm font-medium text-text-tertiary">
            {t("spotlight.empty")}
          </div>
        ) : (
          rules.map((rule, index) => {
            const isEditing = editingRuleId === rule.id

            return (
              <div
                key={rule.id}
                className="overflow-hidden rounded-lg border border-border bg-background shadow-sm transition-colors"
              >
                <SpotlightRuleRow
                  isEditing={isEditing}
                  rule={rule}
                  onEdit={() => {
                    if (isEditing) {
                      setEditingRuleId(null)
                    } else {
                      setEditingRuleId(rule.id)
                    }
                  }}
                  onDelete={() => {
                    deleteRuleAtIndex(rules, index)
                    if (editingRuleId === rule.id) {
                      setEditingRuleId(null)
                    }
                  }}
                />
                {isEditing && (
                  <SpotlightRuleEditor
                    rule={rule}
                    onUpdate={(updater) => {
                      updateRuleAtIndex(rules, index, updater)
                    }}
                  />
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

const SpotlightRuleRow = ({
  rule,
  isEditing,
  onEdit,
  onDelete,
}: {
  rule: SpotlightRule
  isEditing: boolean
  onEdit: () => void
  onDelete: () => void
}) => {
  const { t } = useTranslation("settings")
  const patternText = rule.pattern.trim() || t("spotlight.empty_pattern")

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isEditing}
        className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-fill-quinary"
        onClick={onEdit}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          onEdit()
        }}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span
            className="size-3.5 shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)]"
            style={{ backgroundColor: rule.color }}
          />
          <span className="min-w-0 truncate text-base font-semibold text-text" title={rule.pattern}>
            {patternText}
          </span>
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {rule.enabled && (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue/10 px-2 py-0.5 text-xs text-blue">
              <i className="i-focal-power-outline" />
              {t("integration.status.enabled")}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("words.delete", { ns: "common" })}
            buttonClassName="size-8 p-0 text-text-tertiary hover:text-red"
            onClick={(event) => {
              event.stopPropagation()
              onDelete()
            }}
          >
            <i className="i-focal-delete-2 size-4" />
          </Button>
        </div>
      </div>
    </>
  )
}

const SpotlightRuleEditor = ({
  rule,
  onUpdate,
}: {
  rule: SpotlightRule
  onUpdate: (updater: (rule: SpotlightRule) => SpotlightRule) => void
}) => {
  const { t } = useTranslation("settings")
  const validation = validateSpotlightPattern(rule.pattern, rule.patternType)
  const showRegexError = rule.patternType === "regex" && !validation.valid
  const colorChoices = getSpotlightColorChoices(rule.color)

  const patternInputId = `spotlight-pattern-${rule.id}`
  const caseSensitiveInputId = `spotlight-case-sensitive-${rule.id}`
  const enabledInputId = `spotlight-enabled-${rule.id}`

  return (
    <div className="space-y-4 border-t border-fill-tertiary px-4 py-4">
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <SegmentGroup
            className="h-10 shrink-0 self-center"
            value={rule.patternType}
            onValueChanged={(value) => {
              if (value !== "keyword" && value !== "regex") return
              onUpdate((currentRule) => ({ ...currentRule, patternType: value }))
            }}
          >
            <SegmentItem value="keyword" label={t("spotlight.keyword")} />
            <SegmentItem value="regex" label={t("spotlight.regex")} />
          </SegmentGroup>

          <div className="min-w-0 flex-1">
            <Label className="sr-only" htmlFor={patternInputId}>
              {t("spotlight.pattern")}
            </Label>
            <Input
              id={patternInputId}
              className="h-10 bg-background text-sm"
              placeholder={
                rule.patternType === "keyword"
                  ? t("spotlight.keyword_placeholder")
                  : t("spotlight.regex_placeholder")
              }
              value={rule.pattern}
              onChange={(event) => {
                const pattern = event.target.value
                onUpdate((currentRule) => ({ ...currentRule, pattern }))
              }}
            />
          </div>

          <Switch
            id={enabledInputId}
            className="shrink-0"
            checked={rule.enabled}
            aria-label={t("spotlight.enabled")}
            onCheckedChange={(enabled) => {
              onUpdate((currentRule) => ({ ...currentRule, enabled }))
            }}
          />
        </div>

        {showRegexError && (
          <SettingDescription className="pl-[156px] text-red">
            {t("spotlight.invalid_regex", { error: validation.error })}
          </SettingDescription>
        )}
      </div>

      <div className="flex min-h-8 items-center justify-between gap-4">
        <Label className="text-sm font-medium text-text" htmlFor={caseSensitiveInputId}>
          {t("spotlight.case_sensitive")}
        </Label>
        <Switch
          id={caseSensitiveInputId}
          checked={rule.caseSensitive}
          onCheckedChange={(caseSensitive) => {
            onUpdate((currentRule) => ({ ...currentRule, caseSensitive }))
          }}
        />
      </div>

      <div className="flex items-center gap-4">
        <Label className="shrink-0 text-sm font-medium text-text">{t("spotlight.color")}</Label>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {colorChoices.map((preset) => (
            <SpotlightColorButton
              key={preset.value}
              preset={preset}
              selected={preset.value.toUpperCase() === rule.color.toUpperCase()}
              onClick={() => {
                onUpdate((currentRule) => ({ ...currentRule, color: preset.value }))
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

const SpotlightColorButton = ({
  preset,
  selected,
  onClick,
}: {
  preset: SpotlightColorPreset
  selected: boolean
  onClick: () => void
}) => {
  return (
    <button
      type="button"
      data-spotlight-color-option={preset.value}
      aria-label={`Select highlight color ${preset.value}`}
      className="relative size-5 rounded-full border border-fill-secondary shadow-sm transition-transform duration-200 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2"
      style={{
        backgroundColor: preset.value,
        boxShadow: selected ? "0 0 0 2px hsl(var(--fo-a) / 0.75)" : undefined,
      }}
      onClick={onClick}
    >
      {selected && (
        <span className="center absolute -bottom-1 -right-1 size-3.5 rounded-full bg-blue text-white shadow-sm">
          <i className="i-focal-check text-[8px]" />
        </span>
      )}
    </button>
  )
}
