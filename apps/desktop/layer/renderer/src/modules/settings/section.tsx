/* eslint-disable @eslint-react/no-children-to-array */
/* eslint-disable @eslint-react/no-children-map */

import { cn } from "@follow/utils/utils"
import type { FC, PropsWithChildren, ReactElement, ReactNode } from "react"
import { Children, cloneElement, createContext, use, useEffect, useRef } from "react"

import { SettingActionItem, SettingDescription, SettingSwitch } from "./control"

export const SettingSectionHighlightIdContext = createContext<string | null>(null)

export const SettingInSectionContext = createContext(false)

/** Wraps a section title and its option block with consistent spacing. */
export const SettingSectionGroup: FC<PropsWithChildren<{ className?: string }>> = ({
  children,
  className,
}) => <div className={cn("mb-8 last:mb-2", className)}>{children}</div>

export const SettingSection: FC<PropsWithChildren<{ className?: string }>> = ({
  children,
  className,
}) => (
  <SettingInSectionContext value={true}>
    <div className={cn("divide-y divide-border/60", "[&>*]:py-4", className)}>{children}</div>
  </SettingInSectionContext>
)

export const SettingSectionTitle: FC<{
  title: string | ReactNode
  className?: string
  margin?: "compact" | "normal"
  sectionId?: string
}> = ({ title, margin, className, sectionId }) => {
  const highlightedSectionId = use(SettingSectionHighlightIdContext)
  const elementRef = useRef<HTMLDivElement | null>(null)

  const isHighlighted = !!sectionId && highlightedSectionId === sectionId && !!elementRef.current

  useEffect(() => {
    if (!isHighlighted) {
      return
    }

    let rollingAnimation: Animation | null = null

    const timer = setTimeout(() => {
      const highlightedElement = elementRef.current?.querySelector(
        "[data-highlighted-element]",
      ) as HTMLElement
      if (!highlightedElement) {
        clearTimeout(timer)
        return
      }
      const keyframeEffect = new KeyframeEffect(
        highlightedElement,
        [
          {
            backgroundColor: "color-mix(in srgb, hsl(var(--fo-a)) 33%, hsl(var(--background)) 67%)",
          },
          { backgroundColor: "transparent" },
        ],
        {
          duration: 1000,
          easing: "ease-in-out",
        },
      )
      rollingAnimation = new Animation(keyframeEffect, document.timeline)
      rollingAnimation.play()
    }, 500)
    return () => {
      rollingAnimation?.cancel()
      clearTimeout(timer)
    }
  }, [isHighlighted])
  return (
    <div
      ref={elementRef}
      data-setting-section={sectionId}
      data-highlighted={isHighlighted ? "true" : undefined}
      className={cn(
        "relative shrink-0 text-[17px] font-semibold leading-snug tracking-tight text-text",
        margin === "compact" ? "mb-2.5 mt-6 first:mt-0" : "mb-3 mt-8 first:mt-0",
        className,
      )}
    >
      {isHighlighted && <div className="absolute -inset-4 rounded-lg" data-highlighted-element />}
      {title}
    </div>
  )
}

export const SettingItemGroup: FC<PropsWithChildren<{ className?: string }>> = ({
  children,
  className,
}) => {
  const inSection = use(SettingInSectionContext)
  const childrenArray = Children.toArray(children)
  const normalizedChildren = Children.map(children, (child, index) => {
    if (typeof child !== "object") return child

    if (child === null) return child

    const compType = (child as ReactElement).type
    if (compType === SettingDescription) {
      const prevIndex = index - 1
      const prevChild = childrenArray[prevIndex]
      const prevType = getChildType(prevChild)

      switch (prevType) {
        case SettingSwitch: {
          const childElement = child as ReactElement<{ className?: string }>
          return cloneElement(childElement, {
            className: cn(childElement.props.className, "mt-1"),
          })
        }
        case SettingActionItem: {
          const childElement = child as ReactElement<{ className?: string }>
          return cloneElement(childElement, {
            className: cn(childElement.props.className, "mt-1"),
          })
        }
        default: {
          return child
        }
      }
    }

    return child
  })

  return (
    <div className={cn("transition-colors duration-150", !inSection && "py-4", className)}>
      {normalizedChildren}
    </div>
  )
}

const getChildType = (child: ReactNode) => {
  if (typeof child !== "object") return null

  if (child === null) return null

  return (child as ReactElement).type
}
