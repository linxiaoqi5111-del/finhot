import { useIsDark } from "@follow/hooks"
import * as React from "react"
import { Toaster as Sonner } from "sonner"

import { ZIndexProvider } from "../z-index"
import { toastStyles } from "./styles"

type ToasterProps = React.ComponentProps<typeof Sonner>
const TOAST_Z_INDEX = 999999999

export const Toaster = ({ ...props }: ToasterProps) => {
  const isDark = useIsDark()

  return (
    <ZIndexProvider zIndex={TOAST_Z_INDEX}>
      <Sonner
        theme={isDark ? "dark" : "light"}
        gap={12}
        toastOptions={{
          unstyled: true,
          classNames: toastStyles,
        }}
        icons={{
          success: <i className="i-focal-check-circle" />,
          error: <i className="i-focal-close" />,
          warning: <i className="i-focal-warning" />,
          info: <i className="i-focal-information" />,
          loading: <i className="i-focal-loading-3 animate-spin" />,
        }}
        {...props}
      />
    </ZIndexProvider>
  )
}
