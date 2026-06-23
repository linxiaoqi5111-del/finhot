import { eq } from "drizzle-orm"

import { db } from "../db"
import { entryAiTagsTable } from "../schemas"
import type { EntryAiTagsSchema } from "../schemas/types"
import type { Resetable } from "./internal/base"

class EntryAiTagsServiceStatic implements Resetable {
  async reset() {
    await db.delete(entryAiTagsTable)
  }

  async upsertTags(data: EntryAiTagsSchema) {
    const now = new Date().toISOString()

    await db
      .insert(entryAiTagsTable)
      .values({
        ...data,
        createdAt: data.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: entryAiTagsTable.entryId,
        set: {
          tags: data.tags,
          contentType: data.contentType ?? null,
          contentTypeConfidence: data.contentTypeConfidence ?? null,
          updatedAt: now,
        },
      })
  }

  async getTags(entryId: string) {
    return db.query.entryAiTagsTable.findFirst({
      where: eq(entryAiTagsTable.entryId, entryId),
    })
  }

  async getAllTags() {
    return db.query.entryAiTagsTable.findMany()
  }

  async deleteTags(entryId: string) {
    await db.delete(entryAiTagsTable).where(eq(entryAiTagsTable.entryId, entryId))
  }
}

export const entryAiTagsService = new EntryAiTagsServiceStatic()
