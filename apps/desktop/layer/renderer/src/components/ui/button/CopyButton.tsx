import { useCallback, useRef } from "react"

import { m } from "~/components/common/Motion"
import { copyToClipboard } from "~/lib/clipboard"

import { AnimatedCommandButton } from "./AnimatedCommandButton"

export const CopyButton: Component<{
  value: string
  style?: React.CSSProperties
  variant?: "solid" | "outline" | "ghost"
}> = ({ value, className, style, variant = "solid" }) => {
  const copiedTimerRef = useRef<any>(undefined)
  const handleCopy = useCallback(() => {
    copyToClipboard(value)

    clearTimeout(copiedTimerRef.current)
  }, [value])
  return (
    <AnimatedCommandButton
      className={className}
      style={style}
      variant={variant}
      icon={<m.i className="i-focal-copy-2 size-4" />}
      onClick={handleCopy}
    />
  )
}
