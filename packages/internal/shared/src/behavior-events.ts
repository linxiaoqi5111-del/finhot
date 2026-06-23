export type BehaviorEventType = "favorite" | "read_complete" | "not_interested"

export const BEHAVIOR_EVENT_TYPES = [
  "favorite",
  "read_complete",
  "not_interested",
] as const satisfies readonly BehaviorEventType[]

export const BEHAVIOR_EVENT_WEIGHTS: Record<BehaviorEventType, number> = {
  favorite: 6,
  read_complete: 4,
  not_interested: -6,
}

export function getBehaviorEventPolarity(eventType: BehaviorEventType): "positive" | "negative" {
  return BEHAVIOR_EVENT_WEIGHTS[eventType] >= 0 ? "positive" : "negative"
}
