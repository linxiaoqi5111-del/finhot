import { Button } from "@follow/components/ui/button/index.js"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Queries } from "~/queries"
import { useDeleteRSSHubMutation } from "~/queries/rsshub"

export const ConfirmDeleteModalContent = ({ id, dismiss }: { dismiss: () => void; id: string }) => {
  const { t } = useTranslation("settings")
  const deleteMutation = useDeleteRSSHubMutation({
    onSuccess: () => {
      Queries.rsshub.list().invalidate()
      toast.success(t("rsshub.table.delete.success"))
    },
    onError: (error) => {
      toast.error(error.message)
    },
  })

  return (
    <div className="w-[540px]">
      <div className="mb-4">
        <i className="i-focal-warning -mb-1 mr-1 size-5 text-red-500" />
        {t("rsshub.table.delete.confirm")}
      </div>
      <div className="flex justify-end">
        <Button
          buttonClassName="bg-red-600"
          onClick={() => {
            deleteMutation.mutate(id)
            dismiss()
          }}
        >
          {t("rsshub.table.delete.label")}
        </Button>
      </div>
    </div>
  )
}
