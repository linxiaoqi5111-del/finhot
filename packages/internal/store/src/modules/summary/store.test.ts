import { FollowAPIError } from "@follow-app/client-sdk"
import { beforeEach, describe, expect, test, vi } from "vitest"

import { apiContext, summaryGeneratorContext } from "../../context"
import type { FollowAPI } from "../../types"
import { useEntryStore } from "../entry/store"
import type { EntryModel } from "../entry/types"
import { SummaryGeneratingStatus } from "./enum"
import { summaryBackfillService, summarySyncService, useSummaryStore } from "./store"
import { getGenerateSummaryStatusId } from "./utils"

const { insertSummaryMock } = vi.hoisted(() => ({
  insertSummaryMock: vi.fn(),
}))

vi.mock("@follow/database/services/summary", () => ({
  summaryService: {
    getAllSummaries: vi.fn(),
    insertSummary: insertSummaryMock,
    reset: vi.fn(),
  },
}))

const createEntry = (id: string): EntryModel => ({
  id,
  guid: `${id}-guid`,
  insertedAt: new Date("2026-01-01T00:00:00.000Z"),
  publishedAt: new Date("2026-01-01T00:00:00.000Z"),
})

describe("summarySyncService", () => {
  const entryId = "entry-1"
  const actionLanguage = "en"
  const target = "content"
  const summaryApiMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()

    useEntryStore.setState({
      data: {
        [entryId]: createEntry(entryId),
      },
    })
    useSummaryStore.setState({
      data: {},
      generatingStatus: {},
    })
    summaryGeneratorContext.provide()
    apiContext.provide({
      ai: {
        summary: summaryApiMock,
      },
    } as unknown as FollowAPI)
  })

  test.each([
    { apiData: null, expected: null },
    { apiData: "", expected: null },
  ])(
    "treats empty API summary data as unavailable instead of payment failure",
    async ({ apiData, expected }) => {
      summaryApiMock.mockResolvedValue({ data: apiData })

      await expect(
        summarySyncService.generateSummary({
          entryId,
          target,
          actionLanguage,
        }),
      ).resolves.toBe(expected)

      expect(insertSummaryMock).not.toHaveBeenCalled()
      expect(
        useSummaryStore.getState().generatingStatus[
          getGenerateSummaryStatusId(entryId, actionLanguage, target)
        ],
      ).toBe(SummaryGeneratingStatus.Success)
    },
  )

  test("keeps real API payment errors for the upgrade prompt", async () => {
    const paymentError = new FollowAPIError("Payment required", 402)
    summaryApiMock.mockRejectedValue(paymentError)

    await expect(
      summarySyncService.generateSummary({
        entryId,
        target,
        actionLanguage,
      }),
    ).rejects.toBe(paymentError)

    expect(
      useSummaryStore.getState().generatingStatus[
        getGenerateSummaryStatusId(entryId, actionLanguage, target)
      ],
    ).toBe(SummaryGeneratingStatus.Error)
  })

  test("uses injected local summary generator before the remote API", async () => {
    const localSummaryGenerator = vi.fn().mockResolvedValue("Local BYOK summary")
    summaryGeneratorContext.provide(localSummaryGenerator)

    await expect(
      summarySyncService.generateSummary({
        entryId,
        target,
        actionLanguage,
      }),
    ).resolves.toBe("Local BYOK summary")

    expect(localSummaryGenerator).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId,
        target,
        actionLanguage,
        entry: expect.objectContaining({ id: entryId }),
      }),
    )
    expect(summaryApiMock).not.toHaveBeenCalled()
    expect(insertSummaryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId,
        summary: "Local BYOK summary",
        language: actionLanguage,
      }),
    )
  })

  test("backfills missing summaries without blocking on failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const localSummaryGenerator = vi
      .fn()
      .mockResolvedValueOnce("Entry 2 summary")
      .mockRejectedValueOnce(new Error("entry 3 failed"))

    summaryGeneratorContext.provide(localSummaryGenerator)

    useEntryStore.setState({
      data: {
        [entryId]: createEntry(entryId),
        "entry-2": createEntry("entry-2"),
        "entry-3": createEntry("entry-3"),
        "entry-4": createEntry("entry-4"),
      },
    })
    useSummaryStore.setState({
      data: {
        [entryId]: {
          [actionLanguage]: {
            summary: "Existing summary",
            readabilitySummary: null,
            lastAccessed: Date.now(),
          },
        },
      },
      generatingStatus: {},
    })

    await summaryBackfillService.backfillMissingSummaries({
      entryIds: [entryId, "entry-2", "entry-3", "entry-4"],
      actionLanguage,
      target,
      limit: 2,
    })

    expect(localSummaryGenerator).toHaveBeenCalledTimes(2)
    expect(localSummaryGenerator).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: "entry-2",
      }),
    )
    expect(localSummaryGenerator).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: "entry-3",
      }),
    )
    expect(insertSummaryMock).toHaveBeenCalledTimes(1)
    expect(insertSummaryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: "entry-2",
        summary: "Entry 2 summary",
      }),
    )
    expect(warnSpy).toHaveBeenCalledWith(
      "[summary] Failed to backfill AI summary:",
      "entry-3",
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })
})
