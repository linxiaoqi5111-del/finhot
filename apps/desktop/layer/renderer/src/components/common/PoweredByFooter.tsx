import { cn } from "@follow/utils/utils"
import pkg from "@pkg"

import { FocalLogo, FocalWordmark } from "~/modules/brand/FocalLogo"

export const PoweredByFooter: Component = ({ className }) => (
  <footer className={cn("center mt-12 flex gap-2", className)}>
    {new Date().getFullYear()}
    <FocalLogo className="size-5 rounded-md" />{" "}
    <a
      href={pkg.homepage}
      className="cursor-pointer font-bold no-underline"
      target="_blank"
      rel="noreferrer"
    >
      <FocalWordmark />
    </a>
  </footer>
)
