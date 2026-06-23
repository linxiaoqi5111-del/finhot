/**
 * Pure, deterministic clustering of a topic's entries into sub-topics ("stories")
 * using their embedding vectors. No LLM, no I/O.
 *
 * Algorithm: cosine similarity + single-link connected components (union-find).
 * - Pairs with cosine >= `tau` are linked into the same cluster.
 * - Clusters with size >= `minSize` are real "stories"; the rest are singletons
 *   collected into `misc`.
 * - Near-duplicates (cosine >= `tauDup`) are counted so the UI can show
 *   "same event · N reports"; entries are kept (never silently dropped).
 * - If nothing exceeds `tau`, every item is a singleton -> graceful degrade to a
 *   single time-ordered list (empty `clusters`, full `misc`).
 */

export type ClusterableItem = {
  entryId: string
  vector: number[]
  publishedAt: number
  feedId?: string | null
  title?: string | null
}

export type EntryCluster = {
  id: string
  /** Title of the entry nearest the cluster centroid (no LLM). */
  title: string
  /** Member entry ids, time ascending (read as a thread). */
  entryIds: string[]
  sourceFeedIds: string[]
  latestPublishedAt: number
  size: number
  /** Number of near-duplicate entries beyond the distinct events in the cluster. */
  duplicateCount: number
}

export type ClusterResult = {
  clusters: EntryCluster[]
  /** Singleton entry ids (no story), time descending. */
  misc: string[]
}

export type ClusterOptions = {
  tau?: number
  tauDup?: number
  minSize?: number
  /** Maximum time gap (ms) between two entries to allow linking. If set, entries further apart in time won't cluster even if cosine >= tau. */
  maxTimeGap?: number
}

const DEFAULT_TAU = 0.82
const DEFAULT_TAU_DUP = 0.93
const DEFAULT_MIN_SIZE = 2

const norm = (vector: number[]): number => {
  let sum = 0
  for (const value of vector) sum += value * value
  return Math.sqrt(sum)
}

const dot = (a: number[], b: number[]): number => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!
  return sum
}

class UnionFind {
  private parent: number[]
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i)
  }
  find(x: number): number {
    let root = x
    while (this.parent[root] !== root) root = this.parent[root]!
    // Path compression.
    let current = x
    while (this.parent[current] !== root) {
      const next = this.parent[current]!
      this.parent[current] = root
      current = next
    }
    return root
  }
  union(a: number, b: number) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    // Keep the smaller index as root for deterministic grouping.
    if (ra < rb) this.parent[rb] = ra
    else this.parent[ra] = rb
  }
}

export const clusterEntries = (
  items: ClusterableItem[],
  options: ClusterOptions = {},
): ClusterResult => {
  const tau = options.tau ?? DEFAULT_TAU
  const tauDup = options.tauDup ?? DEFAULT_TAU_DUP
  const minSize = options.minSize ?? DEFAULT_MIN_SIZE

  // Only items with a usable vector participate in clustering; the rest degrade
  // straight into `misc` so we never drop content.
  const valid: { item: ClusterableItem; unit: number[] }[] = []
  const invalidIds: string[] = []
  let dimension = -1

  for (const item of items) {
    const { vector } = item
    if (!Array.isArray(vector) || vector.length === 0) {
      invalidIds.push(item.entryId)
      continue
    }
    if (dimension === -1) dimension = vector.length
    if (vector.length !== dimension) {
      invalidIds.push(item.entryId)
      continue
    }
    const magnitude = norm(vector)
    if (magnitude === 0 || !Number.isFinite(magnitude)) {
      invalidIds.push(item.entryId)
      continue
    }
    valid.push({ item, unit: vector.map((value) => value / magnitude) })
  }

  const maxTimeGap = options.maxTimeGap ?? 0

  const uf = new UnionFind(valid.length)
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      if (maxTimeGap > 0) {
        const timeDiff = Math.abs(valid[i]!.item.publishedAt - valid[j]!.item.publishedAt)
        if (timeDiff > maxTimeGap) continue
      }
      const cosine = dot(valid[i]!.unit, valid[j]!.unit)
      if (cosine >= tau) uf.union(i, j)
    }
  }

  const groups = new Map<number, number[]>()
  for (let i = 0; i < valid.length; i++) {
    const root = uf.find(i)
    const group = groups.get(root)
    if (group) group.push(i)
    else groups.set(root, [i])
  }

  const clusters: EntryCluster[] = []
  const misc: string[] = []

  for (const indices of groups.values()) {
    if (indices.length < minSize) {
      for (const index of indices) misc.push(valid[index]!.item.entryId)
      continue
    }

    const members = indices.map((index) => valid[index]!)

    // Centroid (mean of unit vectors) -> title of the nearest member.
    const centroid = Array.from<number>({ length: dimension }).fill(0)
    for (const { unit } of members) {
      for (let d = 0; d < dimension; d++) centroid[d]! += unit[d]!
    }
    let bestIndex = 0
    let bestScore = -Infinity
    for (const [m, member] of members.entries()) {
      const score = dot(member!.unit, centroid)
      if (score > bestScore) {
        bestScore = score
        bestIndex = m
      }
    }

    // Near-duplicate count via union-find at the higher threshold.
    const dupUf = new UnionFind(members.length)
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        if (dot(members[a]!.unit, members[b]!.unit) >= tauDup) dupUf.union(a, b)
      }
    }
    const distinctEvents = new Set<number>()
    for (let m = 0; m < members.length; m++) distinctEvents.add(dupUf.find(m))

    const sorted = members
      .map((member) => member.item)
      .sort((a, b) => a.publishedAt - b.publishedAt || (a.entryId < b.entryId ? -1 : 1))

    const sourceFeedIds = Array.from(
      new Set(sorted.map((item) => item.feedId).filter((feedId): feedId is string => !!feedId)),
    )
    const latestPublishedAt = sorted.reduce((max, item) => Math.max(max, item.publishedAt), 0)
    const titleSource = members[bestIndex]!.item
    const clusterEntryId = titleSource.entryId

    clusters.push({
      id: `cluster-${clusterEntryId}`,
      title: (titleSource.title ?? "").trim() || "未命名专题",
      entryIds: sorted.map((item) => item.entryId),
      sourceFeedIds,
      latestPublishedAt,
      size: sorted.length,
      duplicateCount: members.length - distinctEvents.size,
    })
  }

  clusters.sort((a, b) => b.latestPublishedAt - a.latestPublishedAt || (a.id < b.id ? -1 : 1))

  // Misc: invalid-vector items + singleton clusters, newest first.
  const allMiscIds = [...misc, ...invalidIds]
  const publishedAtById = new Map(items.map((item) => [item.entryId, item.publishedAt]))
  allMiscIds.sort(
    (a, b) => (publishedAtById.get(b) ?? 0) - (publishedAtById.get(a) ?? 0) || (a < b ? -1 : 1),
  )

  return { clusters, misc: allMiscIds }
}
