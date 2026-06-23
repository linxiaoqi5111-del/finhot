import { and, eq } from "drizzle-orm"

import { db } from "../db"
import { behaviorEventsTable } from "../schemas"
import type { BehaviorEventSchema } from "../schemas/types"
import type { Resetable } from "./internal/base"

class BehaviorEventServiceStatic implements Resetable {
  async reset() {
    await db.delete(behaviorEventsTable)
  }

  async insertEvent(data: BehaviorEventSchema) {
    await db.insert(behaviorEventsTable).values(data)
  }

  async deleteEventsByEntryIdAndType(entryId: string, eventType: string) {
    await db
      .delete(behaviorEventsTable)
      .where(
        and(eq(behaviorEventsTable.entryId, entryId), eq(behaviorEventsTable.eventType, eventType)),
      )
  }

  async getEventsByEntryId(entryId: string) {
    return db.query.behaviorEventsTable.findMany({
      where: eq(behaviorEventsTable.entryId, entryId),
    })
  }

  async getAllEvents() {
    return db.query.behaviorEventsTable.findMany()
  }
}

export const behaviorEventService = new BehaviorEventServiceStatic()

export { type BehaviorEventType } from "@follow/shared/behavior-events"
