import { eq } from "drizzle-orm"

import { db } from "../db"
import { interestClustersTable } from "../schemas"
import type { InterestClusterSchema } from "../schemas/types"
import type { Resetable } from "./internal/base"

class InterestClusterServiceStatic implements Resetable {
  async reset() {
    await db.delete(interestClustersTable)
  }

  async upsertCluster(data: InterestClusterSchema) {
    const now = new Date().toISOString()

    await db
      .insert(interestClustersTable)
      .values({
        ...data,
        createdAt: data.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: interestClustersTable.id,
        set: {
          data: data.data,
          updatedAt: now,
        },
      })
  }

  async getCluster(id: string) {
    return db.query.interestClustersTable.findFirst({
      where: eq(interestClustersTable.id, id),
    })
  }

  async getAllClusters() {
    return db.query.interestClustersTable.findMany()
  }

  async deleteCluster(id: string) {
    await db.delete(interestClustersTable).where(eq(interestClustersTable.id, id))
  }
}

export const interestClusterService = new InterestClusterServiceStatic()

export { type InterestCluster } from "@follow/shared/interest-profile"
