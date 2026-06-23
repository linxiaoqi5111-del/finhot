import { interestClusterService } from "@follow/database/services/interest-cluster"
import type { InterestCluster } from "@follow/shared/interest-profile"

import type { Hydratable, Resetable } from "../../lib/base"
import { createImmerSetter, createTransaction, createZustandStore } from "../../lib/helper"

interface InterestClusterState {
  data: Record<string, InterestCluster>
}

const defaultState: InterestClusterState = {
  data: {},
}

export const useInterestClusterStore = createZustandStore<InterestClusterState>("interest-cluster")(
  () => defaultState,
)

const get = useInterestClusterStore.getState
const set = useInterestClusterStore.setState
const immerSet = createImmerSetter(useInterestClusterStore)

class InterestClusterActions implements Hydratable, Resetable {
  async hydrate() {
    const records = await interestClusterService.getAllClusters()
    immerSet((state) => {
      records.forEach((record) => {
        state.data[record.id] = record.data
      })
    })
  }

  async reset() {
    const tx = createTransaction()
    tx.store(() => {
      set(defaultState)
    })
    tx.persist(() => interestClusterService.reset())
    await tx.run()
  }

  upsertManyInSession(records: Array<{ id: string; data: InterestCluster }>) {
    immerSet((state) => {
      records.forEach((record) => {
        state.data[record.id] = record.data
      })
    })
  }

  async upsertMany(records: Array<{ id: string; data: InterestCluster }>) {
    this.upsertManyInSession(records)

    await Promise.all(
      records.map((record) =>
        interestClusterService.upsertCluster({
          id: record.id,
          data: record.data,
        }),
      ),
    )
  }

  getCluster(id: string) {
    return get().data[id]
  }

  getAllClusters() {
    return Object.values(get().data)
  }
}

export const interestClusterActions = new InterestClusterActions()
