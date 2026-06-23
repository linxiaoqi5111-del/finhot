# AIRSS Rank — Phase 1 Design

Phase 1 adds a **Recommended** timeline alongside the existing **Latest** timeline for local RSS mode. Ranking uses Layer 1 quality scores plus freshness and live read/star state. No embedding or behavior profile yet.

## Goals

- Dual timeline: `latest` (publishedAt desc) vs `recommended` (rank score desc)
- Keep `entry_quality_scores` unchanged — rank consumes it, never replaces it
- Precompute and persist base rank components; apply volatile state at sort time
- Fallback when quality score is missing: freshness-led cold-start ranking

## Architecture

```text
RSS Item ingest
  → enrichment (summary / tags / qualityScore)
  → rank recompute (quality + freshness → DB)
  → hydrate to store

Timeline render
  → getter returns entry id list (latest order from indexes)
  → if recommended mode: sortEntryIds(ids, "recommended")
      final = stored.base_score + live state_score(entry)
```

Future phases extend the same `entry_rank_scores` table and `composeRankScore` composer without breaking Phase 1 records.

---

## Database

### Table: `entry_rank_scores`

| Column       | Type     | Notes                          |
| ------------ | -------- | ------------------------------ |
| `entry_id`   | TEXT PK  | FK logical ref to `entries.id` |
| `data`       | JSON     | `EntryRankRecord` (see below)  |
| `created_at` | TEXT ISO |                                |
| `updated_at` | TEXT ISO |                                |

Migration: `0040_entry_rank_scores.sql`

Also register in `packages/internal/database/src/drizzle/migrations.js` as `m0040` (required by the custom migrator).

### `EntryRankRecord` (JSON in `data`)

```typescript
type EntryRankContext = "cold_start" // Phase 2+: "base" | "full"

interface EntryRankComponents {
  quality_component: number // 0..0.35
  freshness_component: number // 0..0.35
  base_score: number // quality + freshness, 0..0.70
}

interface EntryRankReason {
  type: "quality" | "freshness" | "state" | "fallback"
  label: string
  impact: "positive" | "negative" | "neutral"
}

interface EntryRankRecord {
  context: EntryRankContext
  components: EntryRankComponents
  reasons: EntryRankReason[] // max 5, persisted base reasons only
  computed_at: string // ISO timestamp
}
```

**Not stored** (applied live at sort): `state_score` (read / unread / starred).

Phase 2+ reserved tables (not created in Phase 1):

- `entry_embeddings`
- `behavior_events`
- `interest_clusters`

---

## Rank Composer

Location: `packages/internal/shared/src/entry-rank-score.ts`

### Input

```typescript
interface RankComposerInput {
  publishedAt: Date
  insertedAt?: Date | null
  qualityRecord: EntryQualityScoreRecord | null
  now?: Date
}
```

### Phase 1 formula (cold start)

Weights (aligned with Dibao base ranking, quality as Layer 1 signal):

```text
QUALITY_MAX      = 0.35
FRESHNESS_MAX    = 0.35
FRESHNESS_HALF_LIFE_HOURS = 36

quality_component =
  if qualityRecord:
    (quality_score / 100) * confidence * QUALITY_MAX
  else:
    0

age_hours = (now - coalesce(publishedAt, insertedAt)) in hours
freshness_component =
  exp(-age_hours / FRESHNESS_HALF_LIFE_HOURS) * FRESHNESS_MAX

base_score = clamp(quality_component + freshness_component, 0, 1)
```

### Live state (sort time only)

```typescript
function getStateScore(input: { read: boolean; starred: boolean }): number {
  if (starred) return 0.04
  if (!read) return 0.06
  return -0.08
}

final_score = clamp(base_score + getStateScore(entry), 0, 1)
```

Tie-break: `publishedAt` desc, then `entryId` asc.

### Public API

```typescript
composeRankBase(input: RankComposerInput): EntryRankRecord
getEntryStateScore(input: { read: boolean; starred: boolean }): number
getEntryFinalRankScore(base: EntryRankRecord, stateScore: number): number
sortEntryIdsByRank(
  entryIds: string[],
  getBaseRank: (entryId: string) => EntryRankRecord | undefined,
  getEntry: (entryId: string) => Entry | undefined,
  isStarred: (entryId: string) => boolean,
): string[]
```

---

## Store Module

Location: `packages/internal/store/src/modules/entry-rank-score/`

Mirrors `entry-quality-score` pattern:

- Zustand session cache: `Record<entryId, EntryRankRecord>`
- `entryRankScoreActions.hydrate()` / `reset()` / `upsertMany()` / `getRank(entryId)`
- `entryRankScoreSyncService.recomputeForEntry(entryId)` — reads entry + quality score, writes rank

### Recompute triggers

1. After `entryQualityScoreSyncService.generateScore()` succeeds
2. On new entry ingest (local RSS) — freshness-only until quality arrives
3. Optional backfill when user first enables Recommended timeline

---

## Getter / Sort改造点

### Current

All entry id selectors in `entry/getter.ts` call `sortEntryIdsByPublishDate` before return.

### Phase 1 change

Extract sort helpers to `entry/sort.ts`:

| Function                    | Behavior                          |
| --------------------------- | --------------------------------- |
| `sortEntryIdsByPublishDate` | unchanged                         |
| `sortEntryIdsByRecommended` | rank desc + publishedAt tie-break |
| `sortEntryIds(ids, mode)`   | dispatcher                        |

**Recommended sort is NOT applied inside getter selectors** — getters keep latest order for index consistency. Re-sort happens in the local entries hook when `recommendedTimelineEnabledAtom` is true.

### Files to touch

| File                                                  | Change                                 |
| ----------------------------------------------------- | -------------------------------------- |
| `packages/internal/store/src/modules/entry/getter.ts` | move sort fn → `sort.ts`, re-export    |
| `packages/internal/store/src/modules/entry/sort.ts`   | **new** rank sort                      |
| `apps/desktop/.../hooks/useEntriesByView.ts`          | apply recommended sort on `allEntries` |
| `apps/desktop/.../atoms/recommended-timeline.ts`      | **new** jotai atom                     |
| `apps/desktop/.../layouts/EntryListHeader.tsx`        | toggle button (LOCAL_RSS_MODE)         |

Cloud / remote timeline: unchanged (`aiSort` remains separate).

---

## UI

- Header toggle: **Recommended** ↔ **Latest** (local mode only)
- Icon: reuse spark / sort metaphor (`i-focal-sort-descending` or similar)
- i18n keys: `entry_list_header.recommended_timeline`, `entry_list_header.latest_timeline`
- No rank explanation panel in Phase 1 (Phase 3)

---

## Enrichment pipeline

No new enrichment phase in Phase 1. Rank recompute is invoked directly:

```text
qualityScore phase completes → entryRankScoreSyncService.recomputeForEntry(entryId)
ingest (local)             → entryRankScoreSyncService.recomputeForEntry(entryId)
```

---

## Phase 2+ extension points

| Extension                | Hook                                                                |
| ------------------------ | ------------------------------------------------------------------- |
| Embedding interest score | add `interest_component` to `EntryRankComponents`, context `"full"` |
| Behavior profile         | `behavior_events` → cluster update → rank job                       |
| Quality gate             | filter candidates before rank sort                                  |
| Rank explanations UI     | read `reasons` + live state reasons                                 |

`composeRankScore` should accept optional future components with weight caps; Phase 1 composer ignores them.

---

## Acceptance criteria (Phase 1)

- [ ] `entry_rank_scores` table migrates cleanly
- [ ] Unread entries get rank records on ingest / after quality score
- [ ] Recommended timeline sorts by final rank; Latest unchanged
- [ ] Marking entry read immediately deprioritizes in Recommended view
- [ ] Entries without quality score still appear (freshness-led)
- [ ] `pnpm typecheck` / `lint` / `test` pass
