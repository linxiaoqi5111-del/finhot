import { AnimatePresence, LayoutGroup, m } from "motion/react"
import { useTranslation } from "react-i18next"

export const EntryContentPlaceholder = () => {
  const { t } = useTranslation()

  return (
    <LayoutGroup>
      <AnimatePresence>
        <m.div
          className="center size-full flex-col text-base text-zinc-400"
          initial={{ opacity: 0.01, y: 300 }}
          animate={{ opacity: 1, y: 0 }}
        >
          {t("entry_content.no_selection")}
        </m.div>
      </AnimatePresence>
    </LayoutGroup>
  )
}
