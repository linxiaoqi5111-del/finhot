import { cn } from "@follow/utils/utils"
import type { ImgHTMLAttributes, Ref } from "react"

import focalLogoUrl from "~/assets/focal-logo.png"

// eslint-disable-next-line react-refresh/only-export-components
export const FOCAL_PRODUCT_NAME = "FinHot"
// eslint-disable-next-line react-refresh/only-export-components
export const FOCAL_TAGLINE = "金融信息流阅读器"

export const FocalLogo = ({
  ref,
  className,
  alt = FOCAL_PRODUCT_NAME,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { ref?: Ref<HTMLImageElement | null> }) => (
  <img
    ref={ref}
    className={cn("select-none object-contain", className)}
    src={focalLogoUrl}
    alt={alt}
    {...props}
  />
)

export const FocalWordmark = ({
  ref,
  className,
}: {
  ref?: Ref<HTMLSpanElement | null>
  className?: string
}) => (
  <span ref={ref} className={cn("font-semibold tracking-tight text-text", className)}>
    {FOCAL_PRODUCT_NAME}
  </span>
)
