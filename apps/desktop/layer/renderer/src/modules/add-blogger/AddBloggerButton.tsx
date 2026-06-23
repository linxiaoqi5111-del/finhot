/**
 * A small button that opens the AddBloggerPanel in a modal.
 */

import { PlainModal } from "~/components/ui/modal/stacked/custom-modal"

export function AddBloggerButton() {
  const handleClick = () => {
    import("./AddBloggerPanel").then((mod) => {
      window.presentModal({
        title: "添加博主订阅",
        content: ({ dismiss }) => <mod.AddBloggerPanel onClose={dismiss} />,
        CustomModalComponent: PlainModal,
        modalContainerClassName: "flex items-center justify-center",
        canClose: true,
        clickOutsideToDismiss: true,
        overlay: true,
      })
    })
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-border bg-fill-quaternary px-3 py-2 text-sm text-text-secondary transition-colors hover:border-red/30 hover:bg-red/5 hover:text-text"
    >
      <svg className="size-4" viewBox="0 0 20 20" fill="currentColor">
        <path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" />
      </svg>
      <span>添加博主</span>
    </button>
  )
}
