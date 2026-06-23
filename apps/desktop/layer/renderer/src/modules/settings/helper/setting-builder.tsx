/* eslint-disable @eslint-react/no-array-index-key */
import { Input } from "@follow/components/ui/input/index.js"
import type { SettingPaidLevels } from "@follow/shared/settings/constants"
import { cn } from "@follow/utils/utils"
import type { FC, ReactNode } from "react"
import * as React from "react"
import { cloneElement, isValidElement } from "react"

import {
  SettingActionItem,
  SettingDescription,
  SettingInput,
  SettingRow,
  SettingSwitch,
} from "../control"
import {
  SettingItemGroup,
  SettingSection,
  SettingSectionGroup,
  SettingSectionTitle,
} from "../section"

export { SettingPaidLevels } from "@follow/shared/settings/constants"

type SharedSettingItem = {
  disabled?: boolean
}

export type SettingItem<T, K extends keyof T = keyof T> = {
  key: K
  label: string
  description?: string
  onChange: (value: T[K]) => void
  onChangeGuard?: (value: T[K]) => "handled" | void
  type?: "password"

  vertical?: boolean

  componentProps?: {
    labelClassName?: string
    className?: string
    [key: string]: any
  }
  paidLevel?: SettingPaidLevels
} & SharedSettingItem

type SectionSettingItem = {
  type: "title"
  value?: string
  id?: string
} & SharedSettingItem

type ActionSettingItem = {
  label: string
  action: () => void
  description?: string
  buttonText: string
} & SharedSettingItem
type CustomSettingItem = ReactNode | FC

type RenderedSection = {
  title: ReactNode | null
  items: ReactNode[]
}

const isSectionTitle = (
  setting: SettingItem<any> | SectionSettingItem | ActionSettingItem | CustomSettingItem,
): setting is SectionSettingItem => {
  return (
    typeof setting === "object" && setting !== null && "type" in setting && setting.type === "title"
  )
}

const isEmptySection = (
  settings: (
    | SettingItem<any>
    | SectionSettingItem
    | CustomSettingItem
    | ActionSettingItem
    | boolean
  )[],
  index: number,
) => {
  const nextItem = settings[index + 1]
  return (
    !nextItem || (typeof nextItem === "object" && "type" in nextItem && nextItem.type === "title")
  )
}

export const createSettingBuilder =
  <T extends object>(useSetting: () => T) =>
  <K extends keyof T>(props: {
    settings: (
      | SettingItem<T, K>
      | SectionSettingItem
      | CustomSettingItem
      | ActionSettingItem
      | boolean
    )[]
  }) => {
    const { settings } = props
    const settingObject = useSetting()

    const filteredSettings = settings.filter((i) => !!i)
    const sections: RenderedSection[] = []
    let currentSection: RenderedSection = { title: null, items: [] }

    const pushCurrentSection = () => {
      if (currentSection.title || currentSection.items.length > 0) {
        sections.push(currentSection)
      }
      currentSection = { title: null, items: [] }
    }

    const renderSettingItem = (
      setting: SettingItem<T> | ActionSettingItem,
      index: number,
    ): ReactNode | null => {
      const assertSetting = setting as SettingItem<T> | ActionSettingItem
      let ControlElement: React.ReactNode

      if ("key" in assertSetting) {
        switch (typeof settingObject[assertSetting.key]) {
          case "boolean": {
            ControlElement = (
              <SettingSwitch
                checked={settingObject[assertSetting.key] as boolean}
                onCheckedChange={(checked) => {
                  if (assertSetting.onChangeGuard) {
                    const handled = assertSetting.onChangeGuard(checked as T[keyof T])
                    if (handled === "handled") {
                      return
                    }
                  }
                  assertSetting.onChange(checked as T[keyof T])
                }}
                label={assertSetting.label}
                description={assertSetting.description}
                disabled={assertSetting.disabled}
              />
            )
            break
          }
          case "string": {
            if (assertSetting.description) {
              ControlElement = (
                <SettingRow label={assertSetting.label} description={assertSetting.description}>
                  <Input
                    type={assertSetting.type || "text"}
                    className={cn(
                      "w-72 max-w-full bg-background text-sm",
                      assertSetting.componentProps?.className,
                    )}
                    value={settingObject[assertSetting.key] as string}
                    onChange={(event) => assertSetting.onChange(event.target.value as T[keyof T])}
                  />
                </SettingRow>
              )
            } else {
              ControlElement = (
                <SettingInput
                  vertical={assertSetting.vertical}
                  labelClassName={assertSetting.componentProps?.labelClassName}
                  type={assertSetting.type || "text"}
                  className={assertSetting.componentProps?.className}
                  value={settingObject[assertSetting.key] as string}
                  onChange={(event) => assertSetting.onChange(event.target.value as T[keyof T])}
                  label={assertSetting.label}
                />
              )
            }
            break
          }
          default: {
            return null
          }
        }
      } else if ("action" in assertSetting) {
        ControlElement = <SettingActionItem key={index} {...assertSetting} />
      } else {
        return null
      }

      const isActionItem = "action" in assertSetting
      const isBooleanItem =
        "key" in assertSetting && typeof settingObject[assertSetting.key] === "boolean"
      const hasInlineDescription =
        isBooleanItem ||
        isActionItem ||
        ("key" in assertSetting &&
          typeof settingObject[assertSetting.key] === "string" &&
          !!assertSetting.description)

      return (
        <SettingItemGroup key={index}>
          {ControlElement}
          {!hasInlineDescription && !!assertSetting.description && (
            <SettingDescription>{assertSetting.description}</SettingDescription>
          )}
        </SettingItemGroup>
      )
    }

    filteredSettings.forEach((setting, index) => {
      if (isValidElement(setting)) {
        currentSection.items.push(cloneElement(setting, { key: index }))
        return
      }

      if (typeof setting === "function") {
        currentSection.items.push(React.createElement(setting, { key: index }))
        return
      }

      const assertSetting = setting as SettingItem<T> | SectionSettingItem | ActionSettingItem
      if (!assertSetting) return

      if (isSectionTitle(assertSetting)) {
        if (assertSetting.value && !isEmptySection(filteredSettings, index)) {
          pushCurrentSection()
          currentSection.title = (
            <SettingSectionTitle
              key={`title-${index}`}
              title={assertSetting.value}
              sectionId={assertSetting.id}
            />
          )
        }
        return
      }

      const renderedItem = renderSettingItem(assertSetting, index)
      if (renderedItem) {
        currentSection.items.push(renderedItem)
      }
    })

    pushCurrentSection()

    return sections.map((section, sectionIndex) => (
      <SettingSectionGroup key={sectionIndex}>
        {section.title}
        {section.items.length > 0 && <SettingSection>{section.items}</SettingSection>}
      </SettingSectionGroup>
    ))
  }
