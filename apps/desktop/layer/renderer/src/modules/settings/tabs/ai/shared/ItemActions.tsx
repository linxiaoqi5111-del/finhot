import { Button } from "@follow/components/ui/button/index.js"
import { Switch } from "@follow/components/ui/switch/index.jsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "@follow/components/ui/tooltip/index.jsx"

export interface ActionButton {
  icon: string
  onClick: () => void
  title?: string
  disabled?: boolean
  loading?: boolean
}

interface ItemActionsProps {
  actions: ActionButton[]
  enabled: boolean
  onToggle: (enabled: boolean) => void
}

export const ItemActions = ({ actions, enabled, onToggle }: ItemActionsProps) => (
  <div className="ml-4 flex items-center gap-3">
    <div className="flex items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
      {actions.map((action) =>
        action.title ? (
          <Tooltip key={action.title} delayDuration={300}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={action.onClick} disabled={action.disabled}>
                {action.loading ? (
                  <i className="i-focal-loading-3 size-4 animate-spin" />
                ) : (
                  <i className={`${action.icon} size-4`} />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{action.title}</TooltipContent>
          </Tooltip>
        ) : (
          <Button
            key={action.icon}
            variant="ghost"
            size="sm"
            onClick={action.onClick}
            disabled={action.disabled}
          >
            {action.loading ? (
              <i className="i-focal-loading-3 size-4 animate-spin" />
            ) : (
              <i className={`${action.icon} size-4`} />
            )}
          </Button>
        ),
      )}
    </div>

    <div className="flex items-center gap-2 border-l border-fill-tertiary pl-3">
      <Switch checked={enabled} onCheckedChange={onToggle} />
    </div>
  </div>
)
