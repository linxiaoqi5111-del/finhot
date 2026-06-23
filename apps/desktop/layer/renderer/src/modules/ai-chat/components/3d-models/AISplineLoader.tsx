import { cn } from "@follow/utils"

import { FocalLogo } from "~/modules/brand/FocalLogo"

export const AISplineLoader = ({ className }: { className?: string }) => {
  return (
    <div className={cn("center size-16", className)}>
      <FocalLogo className="size-full rounded-[22%]" />
    </div>
  )
}
