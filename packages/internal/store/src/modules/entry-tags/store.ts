import { entryAiTagsService } from "@follow/database/services/entry-ai-tags"
import type { EntryAiTagAssignment, EntryContentTypeAssignment } from "@follow/shared/entry-ai-tags"
import type { SupportedActionLanguage } from "@follow/shared/language"

import { tagGenerator } from "../../context"
import type { Hydratable, Resetable } from "../../lib/base"
import { createImmerSetter, createTransaction, createZustandStore } from "../../lib/helper"
import { getEntry } from "../entry/getter"
import { summaryActions } from "../summary/store"
import { validateContentType, validateTagAssignments } from "./utils"

interface EntryAiTagsState {
  data: Record<string, EntryAiTagAssignment[]>
  contentType: Record<string, EntryContentTypeAssignment>
}

const defaultState: EntryAiTagsState = {
  data: {},
  contentType: {},
}

type UpsertTagsRecord = {
  entryId: string
  tags: EntryAiTagAssignment[]
  contentType?: EntryContentTypeAssignment | null
}

export const useEntryAiTagsStore = createZustandStore<EntryAiTagsState>("entry-ai-tags")(
  () => defaultState,
)

const get = useEntryAiTagsStore.getState
const set = useEntryAiTagsStore.setState
const immerSet = createImmerSetter(useEntryAiTagsStore)

class EntryAiTagsActions implements Hydratable, Resetable {
  async hydrate() {
    const records = await entryAiTagsService.getAllTags()
    immerSet((state) => {
      records.forEach((record) => {
        state.data[record.entryId] = record.tags
        if (record.contentType) {
          state.contentType[record.entryId] = {
            label: record.contentType,
            confidence: record.contentTypeConfidence ?? 0,
          }
        }
      })
    })
  }

  async reset() {
    const tx = createTransaction()
    tx.store(() => {
      set(defaultState)
    })
    tx.persist(() => entryAiTagsService.reset())
    await tx.run()
  }

  upsertManyInSession(records: UpsertTagsRecord[]) {
    immerSet((state) => {
      records.forEach((record) => {
        state.data[record.entryId] = record.tags
        if (record.contentType) {
          state.contentType[record.entryId] = record.contentType
        }
      })
    })
  }

  async upsertMany(records: UpsertTagsRecord[]) {
    this.upsertManyInSession(records)

    await Promise.all(
      records.map((record) =>
        entryAiTagsService.upsertTags({
          entryId: record.entryId,
          tags: record.tags,
          contentType: record.contentType?.label ?? null,
          contentTypeConfidence: record.contentType?.confidence ?? null,
        }),
      ),
    )
  }

  getTags(entryId: string) {
    return get().data[entryId]
  }

  getContentType(entryId: string) {
    return get().contentType[entryId]
  }
}

export const entryAiTagsActions = new EntryAiTagsActions()

class EntryAiTagsSyncService {
  async generateTags({
    entryId,
    actionLanguage,
  }: {
    entryId: string
    actionLanguage: SupportedActionLanguage
  }) {
    const existing = entryAiTagsActions.getTags(entryId)
    // Re-run when tags exist but contentType is missing (entries tagged before
    // the contentType field existed) so the genre label backfills.
    if (existing?.length && entryAiTagsActions.getContentType(entryId)) return existing

    const localTagGenerator = tagGenerator()
    if (!localTagGenerator) return null

    const entry = getEntry(entryId)
    if (!entry) return null

    const summary = summaryActions.getSummary(entryId, actionLanguage)?.summary ?? null
    const generated = await localTagGenerator({
      entryId,
      entry,
      actionLanguage,
      summary,
    })

    const tags = validateTagAssignments(generated)
    if (tags.length === 0) return null

    const contentType = validateContentType(generated.contentType)

    await entryAiTagsActions.upsertMany([{ entryId, tags, contentType }])
    return tags
  }
}

export const entryAiTagsSyncService = new EntryAiTagsSyncService()
