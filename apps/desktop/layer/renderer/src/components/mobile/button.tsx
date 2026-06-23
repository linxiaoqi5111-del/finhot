import { MotionButtonBase } from "@follow/components/ui/button/index.js"
import { cn } from "@follow/utils/utils"
import { useTranslation } from "react-i18next"

export const HeaderTopReturnBackButton: Component<{ to?: string }> = ({ className, to }) => {
  const { t } = useTranslation("common")

  return (
    <MotionButtonBase
      onClick={() => window.history.returnBack(to)}
      className={cn("center size-8", className)}
    >
      <i className="i-focal-left size-6" />

      <span className="sr-only">{t("words.back")}</span>
    </MotionButtonBase>
  )
}
