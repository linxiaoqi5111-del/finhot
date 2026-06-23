import { eq } from "drizzle-orm"

import { db } from "../db"
import { entryRankScoresTable } from "../schemas"
import type { EntryRankScoreSchema } from "../schemas/types"
import type { Resetable } from "./internal/base"

class EntryRankScoreServiceStatic implements Resetable {
  async reset() {
    await db.delete(entryRankScoresTable)
  }

  async upsertScore(data: EntryRankScoreSchema) {
    const now = new Date().toISOString()

    await db
      .insert(entryRankScoresTable)
      .values({
        ...data,
        createdAt: data.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: entryRankScoresTable.entryId,
        set: {
          data: data.data,
          updatedAt: now,
        },
      })
  }

  async getScore(entryId: string) {
    return db.query.entryRankScoresTable.findFirst({
      where: eq(entryRankScoresTable.entryId, entryId),
    })
  }

  async getAllScores() {
    return db.query.entryRankScoresTable.findMany()
  }

  async deleteScore(entryId: string) {
    await db.delete(entryRankScoresTable).where(eq(entryRankScoresTable.entryId, entryId))
  }
}

export const entryRankScoreService = new EntryRankScoreServiceStatic()

export { type EntryRankRecord } from "@follow/shared/entry-rank-score"
