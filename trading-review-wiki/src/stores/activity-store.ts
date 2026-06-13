import { create } from "zustand"

export type PlanItemStatus = "pending" | "running" | "done" | "error"

export interface PlanItem {
  id: string
  action: "create" | "update" | "append"
  path: string
  why?: string
  status: PlanItemStatus
  error?: string
  note?: string
  stage: 3 | 4
}

export interface IngestStage {
  step: number
  label: string
  status: PlanItemStatus
  error?: string
}

export interface ActivityItem {
  id: string
  type: "ingest" | "lint" | "query"
  title: string
  status: "running" | "done" | "error"
  detail: string
  filesWritten: string[]
  plan?: PlanItem[]
  stages?: IngestStage[]
  createdAt: number
}

interface ActivityState {
  items: ActivityItem[]
  addItem: (item: Omit<ActivityItem, "id" | "createdAt">) => string
  updateItem: (id: string, updates: Partial<Pick<ActivityItem, "status" | "detail" | "filesWritten">>) => void
  appendDetail: (id: string, text: string) => void
  setPlan: (id: string, items: PlanItem[]) => void
  updatePlanItem: (id: string, planItemId: string, updates: Partial<Pick<PlanItem, "status" | "error" | "note">>) => void
  setStages: (id: string, stages: IngestStage[]) => void
  updateStage: (id: string, step: number, updates: Partial<Pick<IngestStage, "status" | "error">>) => void
  clearDone: () => void
}

let counter = 0

export const useActivityStore = create<ActivityState>((set, get) => ({
  items: [],

  addItem: (item) => {
    const id = `activity-${++counter}`
    set((state) => ({
      items: [
        { ...item, id, createdAt: Date.now() },
        ...state.items,
      ],
    }))
    return id
  },

  updateItem: (id, updates) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, ...updates } : item
      ),
    })),

  appendDetail: (id, text) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, detail: item.detail + text } : item
      ),
    })),

  setPlan: (id, planItems) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, plan: planItems } : item
      ),
    })),

  updatePlanItem: (id, planItemId, updates) =>
    set((state) => ({
      items: state.items.map((item) => {
        if (item.id !== id || !item.plan) return item
        return {
          ...item,
          plan: item.plan.map((p) => (p.id === planItemId ? { ...p, ...updates } : p)),
        }
      }),
    })),

  setStages: (id, stages) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, stages } : item
      ),
    })),

  updateStage: (id, step, updates) =>
    set((state) => ({
      items: state.items.map((item) => {
        if (item.id !== id || !item.stages) return item
        return {
          ...item,
          stages: item.stages.map((s) => (s.step === step ? { ...s, ...updates } : s)),
        }
      }),
    })),

  clearDone: () =>
    set((state) => ({
      items: state.items.filter((i) => i.status === "running"),
    })),
}))
