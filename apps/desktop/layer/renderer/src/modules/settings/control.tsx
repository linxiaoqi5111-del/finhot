import { Button } from "@follow/components/ui/button/index.js"
import { Checkbox } from "@follow/components/ui/checkbox/index.jsx"
import { Input, TextArea } from "@follow/components/ui/input/index.js"
import { Label } from "@follow/components/ui/label/index.jsx"
import { SegmentGroup, SegmentItem } from "@follow/components/ui/segment/index.jsx"
import { Switch } from "@follow/components/ui/switch/index.jsx"
import { cn } from "@follow/utils/utils"
import type { ChangeEventHandler, ReactNode } from "react"
import { useId, useState } from "react"

export const settingRowLabelClass = "text-sm font-medium leading-snug text-text"
export const settingRowDescriptionClass = "text-[13px] leading-5 text-text-tertiary"

export const SettingRow: Component<{
  label: ReactNode
  description?: ReactNode
  children: ReactNode
}> = ({ label, description, children, className }) => (
  <div className={cn("flex min-h-8 items-center justify-between gap-5", className)}>
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className={settingRowLabelClass}>{label}</div>
      {description != null && description !== "" && (
        <span className={settingRowDescriptionClass}>{description}</span>
      )}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
)

export const SettingCheckbox: Component<{
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}> = ({ checked, label, onCheckedChange }) => {
  const id = useId()
  return (
    <div className="mb-2 flex items-center gap-4">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="cursor-auto"
      />
      <Label htmlFor={id}>{label}</Label>
    </div>
  )
}

export const SettingSwitch: Component<{
  label: string
  description?: ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}> = ({ checked, label, description, onCheckedChange, className, disabled }) => {
  const id = useId()
  const handleCheckedChange = (checked: boolean) => {
    onCheckedChange(checked)
  }
  return (
    <SettingRow label={label} description={description} className={className}>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={handleCheckedChange}
        disabled={disabled}
        className="shrink-0"
      />
    </SettingRow>
  )
}

export const SettingInput: Component<{
  label: string
  value: string
  onChange: ChangeEventHandler<HTMLInputElement>
  type: string
  vertical?: boolean
  labelClassName?: string
}> = ({ value, label, onChange, labelClassName, className, type, vertical }) => {
  const id = useId()

  return (
    <div
      className={cn(
        "flex",
        vertical ? "flex-col gap-2.5" : "flex-row items-center justify-between gap-10",
        className,
      )}
    >
      <Label
        className={cn("shrink-0 text-sm font-medium leading-snug text-text", labelClassName)}
        htmlFor={id}
      >
        {label}
      </Label>
      <Input
        type={type}
        id={id}
        value={value}
        onChange={onChange}
        className="max-w-72 bg-background text-sm"
      />
    </div>
  )
}

export const SettingTextArea: Component<{
  label: string
  value: string
  onChange: ChangeEventHandler<HTMLTextAreaElement>
  vertical?: boolean
  labelClassName?: string
}> = ({ value, label, onChange, labelClassName, className, vertical }) => {
  const id = useId()

  return (
    <div
      className={cn(
        "flex",
        vertical ? "flex-col gap-2.5" : "flex-row items-center justify-between gap-10",
        className,
      )}
    >
      <Label
        className={cn("shrink-0 text-sm font-medium leading-snug text-text", labelClassName)}
        htmlFor={id}
      >
        {label}
      </Label>
      <TextArea id={id} value={value} onChange={onChange} className="bg-background text-sm" />
    </div>
  )
}

export const SettingTabbedSegment: Component<{
  label: ReactNode
  value: string
  onValueChanged?: (value: string) => void
  values: { value: string; label: string; icon?: ReactNode }[]
  description?: string
}> = ({ label, className, value, values, onValueChanged, description }) => {
  const [currentValue, setCurrentValue] = useState(value)

  return (
    <SettingRow label={label} description={description} className={className}>
      <SegmentGroup
        className="h-8 shrink-0"
        value={currentValue}
        onValueChanged={(v) => {
          setCurrentValue(v)
          onValueChanged?.(v)
        }}
      >
        {values.map((v) => (
          <SegmentItem
            key={v.value}
            value={v.value}
            label={
              <div className="flex items-center gap-1">
                {v.icon}
                <span>{v.label}</span>
              </div>
            }
          />
        ))}
      </SegmentGroup>
    </SettingRow>
  )
}

export const SettingDescription: Component = ({ children, className }) => (
  <small
    className={cn("mt-1 block max-w-[32rem] text-[13px] leading-5 text-text-tertiary", className)}
  >
    {children}
  </small>
)

export const SettingActionItem = ({
  label,
  description,
  action,
  buttonText,
  className,
}: {
  label: ReactNode
  description?: ReactNode
  action: () => void
  buttonText: string
  className?: string
}) => (
  <SettingRow label={label} description={description} className={className}>
    <Button variant="outline" size="sm" onClick={action}>
      {buttonText}
    </Button>
  </SettingRow>
)
