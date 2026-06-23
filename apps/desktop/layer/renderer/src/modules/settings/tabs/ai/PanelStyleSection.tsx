import { useTranslation } from "react-i18next"

import { AIChatPanelStyle, setAIChatPanelStyle, useAIChatPanelStyle } from "~/atoms/settings/ai"

import { SettingTabbedSegment } from "../../control"
import { SettingItemGroup } from "../../section"

export const PanelStyleSection = () => {
  const { t } = useTranslation("ai")
  const panelStyle = useAIChatPanelStyle()

  return (
    <SettingItemGroup>
      <SettingTabbedSegment
        key="panel-style"
        label={t("settings.panel_style.label")}
        description={t("settings.panel_style.description")}
        value={panelStyle}
        values={[
          {
            value: AIChatPanelStyle.Fixed,
            label: t("settings.panel_style.fixed"),
            icon: <i className="i-focal-rectangle-vertical" />,
          },
          {
            value: AIChatPanelStyle.Floating,
            label: t("settings.panel_style.floating"),
            icon: <i className="i-focal-layout-right" />,
          },
        ]}
        onValueChanged={(value) => {
          setAIChatPanelStyle(value as AIChatPanelStyle)
        }}
      />
    </SettingItemGroup>
  )
}
