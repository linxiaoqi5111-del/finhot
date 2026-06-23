import { cn } from "@follow/utils/utils"
import type { ReactNode } from "react"

export const CollapsibleSectionHeader = ({
  children,
  className,
  isOpen,
  onToggle,
}: {
  children: ReactNode
  className?: string
  isOpen: boolean
  onToggle: () => void
}) => (
  <button
    type="button"
    data-selecto-ignore
    aria-expanded={isOpen}
    className={cn(
      "group no-drag-region pointer-events-auto flex h-6 w-full shrink-0 items-center rounded-md px-2.5 text-left text-xs font-semibold text-text-secondary transition-colors hover:bg-fill-secondary hover:text-text",
      className,
    )}
    onPointerDown={(event) => {
      event.stopPropagation()
    }}
    onClick={(event) => {
      event.stopPropagation()
      onToggle()
    }}
  >
    <span className="min-w-0 flex-1 truncate">{children}</span>
    <i
      aria-hidden
      className={cn(
        "i-focal-right-fill size-3 shrink-0 text-text-tertiary opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
        isOpen && "rotate-90",
      )}
    />
  </button>
)
