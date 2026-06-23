import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import { cn } from "@follow/utils"
import { createElement, lazy, Suspense } from "react"

import { ErrorBoundary } from "~/components/common/ErrorBoundary"
import { FocalLogo } from "~/modules/brand/FocalLogo"

const AISplineLoader = lazy(() =>
  import("./AISplineLoader").then((res) => ({ default: res.AISplineLoader })),
)
export const AISpline = ({ className }: { className?: string }) => {
  if (LOCAL_RSS_MODE) {
    return createElement(FocalLogo, { className: cn("rounded-[22%]", className) })
  }

  return createElement(
    ErrorBoundary,
    {
      handled: true,
    },
    createElement(
      Suspense,
      {
        fallback: createElement("div", { className: cn("size-20 mx-auto", className) }),
      },
      createElement(AISplineLoader, { className }),
    ),
  )
}
