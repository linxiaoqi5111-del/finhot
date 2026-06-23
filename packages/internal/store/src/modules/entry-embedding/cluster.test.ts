import { describe, expect, it } from "vitest"

import type { ClusterableItem } from "./cluster"
import { clusterEntries } from "./cluster"

const item = (
  entryId: string,
  vector: number[],
  publishedAt: number,
  extra?: Partial<ClusterableItem>,
): ClusterableItem => ({ entryId, vector, publishedAt, ...extra })

describe("clusterEntries", () => {
  it("splits two tight groups into two clusters", () => {
    const items = [
      item("a1", [1, 0], 10, { feedId: "f1", title: "A one" }),
      item("a2", [0.99, 0.1], 20, { feedId: "f2", title: "A two" }),
      item("b1", [0, 1], 30, { feedId: "f3", title: "B one" }),
      item("b2", [0.1, 0.99], 40, { feedId: "f3", title: "B two" }),
    ]

    const { clusters, misc } = clusterEntries(items)

    expect(clusters).toHaveLength(2)
    expect(misc).toHaveLength(0)
    // Ordered by latestPublishedAt desc -> B cluster (latest 40) first.
    expect(clusters[0]!.entryIds).toEqual(["b1", "b2"])
    expect(clusters[0]!.latestPublishedAt).toBe(40)
    expect(clusters[1]!.entryIds).toEqual(["a1", "a2"])
    expect(clusters[0]!.sourceFeedIds).toEqual(["f3"])
    expect(clusters[1]!.sourceFeedIds).toEqual(["f1", "f2"])
  })

  it("degrades to misc when nothing is similar enough", () => {
    const items = [item("x", [1, 0], 1), item("y", [0, 1], 2), item("z", [-1, 0], 3)]

    const { clusters, misc } = clusterEntries(items)

    expect(clusters).toHaveLength(0)
    // Newest first.
    expect(misc).toEqual(["z", "y", "x"])
  })

  it("counts near-duplicates without dropping entries", () => {
    const items = [
      item("d0", [1, 0], 10, { title: "Event" }),
      item("d1", [1, 0], 20, { title: "Event (mirror)" }),
      // ~28deg from [1,0]: in-cluster (cos .883 >= tau) but not a duplicate (< tauDup).
      item("d2", [0.883, 0.469], 30, { title: "Related angle" }),
    ]

    const { clusters } = clusterEntries(items)

    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.size).toBe(3)
    expect(clusters[0]!.entryIds).toEqual(["d0", "d1", "d2"])
    expect(clusters[0]!.duplicateCount).toBe(1)
  })

  it("routes entries with invalid vectors to misc", () => {
    const items = [
      item("ok1", [1, 0], 10),
      item("ok2", [0.98, 0.05], 20),
      item("bad", [], 30),
      item("mismatch", [1, 0, 0], 40),
    ]

    const { clusters, misc } = clusterEntries(items)

    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.entryIds).toEqual(["ok1", "ok2"])
    expect(misc).toEqual(["mismatch", "bad"])
  })

  it("is deterministic across runs", () => {
    const items = [
      item("a1", [1, 0], 10),
      item("a2", [0.97, 0.12], 20),
      item("b1", [0, 1], 30),
      item("b2", [0.05, 0.99], 40),
      item("s", [0.7, 0.71], 50),
    ]

    expect(clusterEntries(items)).toEqual(clusterEntries(items))
  })

  it("handles empty input", () => {
    expect(clusterEntries([])).toEqual({ clusters: [], misc: [] })
  })
})
