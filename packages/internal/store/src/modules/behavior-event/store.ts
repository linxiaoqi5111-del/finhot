import { behaviorEventService } from "@follow/database/services/behavior-event"
import type { BehaviorEventType } from "@follow/shared/behavior-events"
import { getBehaviorEventPolarity } from "@follow/shared/behavior-events"
import { INTEREST_CLUSTER_IDS, updateInterestCluster } from "@follow/shared/interest-profile"

import type { Hydratable, Resetable } from "../../lib/base"
import { createImmerSetter, createTransaction, createZustandStore } from "../../lib/helper"
import { entryEmbeddingActions, useEntryEmbeddingStore } from "../entry-embedding/store"
import { entryRankScoreSyncService } from "../entry-rank-score/store"
import { interestClusterActions } from "../interest-cluster/store"

interface BehaviorEventState {
  events: Array<{
    id: string
    entryId: string
    eventType: BehaviorEventType
    createdAt: string
  }>
}

type BehaviorEvent = BehaviorEventState["events"][number]

export const removeBehaviorEvents = (
  events: readonly BehaviorEvent[],
  entryId: string,
  eventType: BehaviorEventType,
) => events.filter((event) => event.entryId !== entryId || event.eventType !== eventType)

const defaultState: BehaviorEventState = {
  events: [],
}

export const useBehaviorEventStore = createZustandStore<BehaviorEventState>("behavior-event")(
  () => defaultState,
)

const set = useBehaviorEventStore.setState
const immerSet = createImmerSetter(useBehaviorEventStore)

class BehaviorEventActions implements Hydratable, Resetable {
  async hydrate() {
    const records = await behaviorEventService.getAllEvents()
    immerSet((state) => {
      state.events = records.map((record) => ({
        id: record.id,
        entryId: record.entryId,
        eventType: record.eventType as BehaviorEventType,
        createdAt: record.createdAt,
      }))
    })
  }

  async reset() {
    const tx = createTransaction()
    tx.store(() => {
      set(defaultState)
    })
    tx.persist(() => behaviorEventService.reset())
    await tx.run()
  }

  appendEventInSession(event: BehaviorEventState["events"][number]) {
    immerSet((state) => {
      state.events.push(event)
    })
  }

  removeEventsInSession(entryId: string, eventType: BehaviorEventType) {
    immerSet((state) => {
      state.events = removeBehaviorEvents(state.events, entryId, eventType)
    })
  }
}

export const behaviorEventActions = new BehaviorEventActions()

class BehaviorEventSyncService {
  private rankRecomputeTimer: ReturnType<typeof setTimeout> | null = null

  async record(entryId: string, eventType: BehaviorEventType) {
    const id = `${entryId}-${eventType}-${Date.now()}`
    const createdAt = new Date().toISOString()

    await behaviorEventService.insertEvent({
      id,
      entryId,
      eventType,
      createdAt,
    })

    behaviorEventActions.appendEventInSession({
      id,
      entryId,
      eventType,
      createdAt,
    })

    const embedding = entryEmbeddingActions.getEmbedding(entryId)
    if (embedding?.vector && embedding.vector.length > 0) {
      await this.updateInterestProfile(embedding.vector, eventType)
      this.scheduleRankRecompute()
    }

    await entryRankScoreSyncService.recomputeForEntry(entryId, { force: true })
  }

  private scheduleRankRecompute() {
    if (this.rankRecomputeTimer) {
      clearTimeout(this.rankRecomputeTimer)
    }

    this.rankRecomputeTimer = setTimeout(() => {
      this.rankRecomputeTimer = null
      const entryIds = Object.keys(useEntryEmbeddingStore.getState().data)
      if (entryIds.length === 0) return

      void entryRankScoreSyncService.recomputeForEntries(entryIds, { force: true })
    }, 500)
  }

  private async updateInterestProfile(vector: number[], eventType: BehaviorEventType) {
    const polarity = getBehaviorEventPolarity(eventType)
    const clusterId =
      polarity === "positive" ? INTEREST_CLUSTER_IDS.positive : INTEREST_CLUSTER_IDS.negative
    const existing = interestClusterActions.getCluster(clusterId) ?? null
    const updated = updateInterestCluster({
      cluster: existing,
      vector,
      eventType,
    })

    await interestClusterActions.upsertMany([{ id: clusterId, data: updated }])
  }

  recordFavorite(entryId: string) {
    return this.record(entryId, "favorite")
  }

  recordReadComplete(entryId: string) {
    return this.record(entryId, "read_complete")
  }

  recordNotInterested(entryId: string) {
    return this.record(entryId, "not_interested")
  }

  async remove(entryId: string, eventType: BehaviorEventType) {
    await behaviorEventService.deleteEventsByEntryIdAndType(entryId, eventType)
    behaviorEventActions.removeEventsInSession(entryId, eventType)
    await entryRankScoreSyncService.recomputeForEntry(entryId, { force: true })
  }

  removeNotInterested(entryId: string) {
    return this.remove(entryId, "not_interested")
  }
}

export const behaviorEventSyncService = new BehaviorEventSyncService()
