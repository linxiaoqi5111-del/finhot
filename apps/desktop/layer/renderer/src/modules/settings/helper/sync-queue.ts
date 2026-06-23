import type { AISettings, GeneralSettings, UISettings } from "@follow/shared/settings/interface"
import type { SpotlightSettings } from "@follow/shared/spotlight"

type SettingMapping = {
  appearance: UISettings
  general: GeneralSettings
  ai: AISettings
  spotlight: SpotlightSettings
}

export type SettingSyncTab = keyof SettingMapping

export interface SettingSyncQueueItem<T extends SettingSyncTab = SettingSyncTab> {
  tab: T
  payload: Partial<SettingMapping[T]>
  date: number
}

export const isRemoteSettingSyncEnabled = () => false

class SettingSyncQueue {
  queue: SettingSyncQueueItem[] = []

  async init() {}

  teardown() {
    this.queue = []
  }

  load() {
    this.queue = []
  }

  save() {}

  async enqueue<T extends SettingSyncTab>(_tab: T, _payload: Partial<SettingMapping[T]>) {}

  replaceRemote(_tab?: SettingSyncTab) {
    return Promise.resolve()
  }

  async syncLocal() {}
}

export const settingSyncQueue = new SettingSyncQueue()
