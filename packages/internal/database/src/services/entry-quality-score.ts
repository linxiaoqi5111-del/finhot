import { eq } from "drizzle-orm"

import { db } from "../db"
import { entryQualityScoresTable } from "../schemas"
import type { EntryQualityScoreSchema } from "../schemas/types"
import type { Resetable } from "./internal/base"

class EntryQualityScoreServiceStatic implements Resetable {
  async reset() {
    await db.delete(entryQualityScoresTable)
  }

  async upsertScore(data: EntryQualityScoreSchema) {
    const now = new Date().toISOString()

    await db
      .insert(entryQualityScoresTable)
      .values({
        ...data,
        createdAt: data.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: entryQualityScoresTable.entryId,
        set: {
          data: data.data,
          updatedAt: now,
        },
      })
  }

  async getScore(entryId: string) {
    return db.query.entryQualityScoresTable.findFirst({
      where: eq(entryQualityScoresTable.entryId, entryId),
    })
  }

  async getAllScores() {
    return db.query.entryQualityScoresTable.findMany()
  }

  async deleteScore(entryId: string) {
    await db.delete(entryQualityScoresTable).where(eq(entryQualityScoresTable.entryId, entryId))
  }
}

export const entryQualityScoreService = new EntryQualityScoreServiceStatic()

export { type EntryQualityScoreRecord } from "@follow/shared/entry-quality-score"
