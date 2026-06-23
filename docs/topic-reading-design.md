# Topic Reading — Design & Phased Plan

## Background & Problem

The desktop sidebar renders an always-expanded **Topics** section
(`TimelineScopeItems`) that lists the fixed AI tag buckets
(`ENTRY_AI_TAG_CANDIDATES`, currently 10). Each topic is a full-height row
(`h-8` + `mt-1` ≈ 36px), so a fully populated list costs ~360px and pushes the
actual feed sources below the fold.

The root cause is **not** "topics take space" but that **source navigation and
topic navigation are two orthogonal axes** (where content comes from vs. what
content is about) rendered as one competing vertical list. Topics are a _lens on
content_ (AI tags), not a _navigation source_ like feeds.

The product intent behind pulling tags out as "Topics" is **topic reading**:
sitting down to read a theme across all feeds, where the N articles on a topic
are woven together by some logic rather than shown as a flat list.

## Goals

- Stop topics from squeezing the sidebar; the sidebar shows only a small,
  curated set of followed topics.
- Make "topic reading" a first-class activity: enter a topic and read a
  coherent, clustered, time-threaded session instead of a flat list.
- Keep the topic set small and self-governing (no manual gardening, no
  unbounded growth).
- Build on existing infra (embeddings, AI tags, summaries, quality score,
  grouped virtualized list, neighbor navigation) — minimize net new surface.

## Non-goals

- No new top-level layout/columns.
- No mandatory LLM calls in the baseline reading experience (LLM features are
  isolated and optional, see Phase 3).
- No change to how AI tags are generated (the enrichment pipeline is reused).

---

## Core Design Decisions

1. **One Topics section, not two.** The fixed AI buckets and user-created topics
   are the same thing at different curation stages. The sidebar has a single
   **Topics** block that lists only _followed_ topics. The full AI bucket
   catalog + discovery live behind a "Browse all topics" entry, not as permanent
   rows. Net sidebar footprint ends up **smaller than today**.

2. **Topic = a content selector.** A topic is defined by one of: an AI tag, a
   keyword query, a semantic/embedding query, or a manual set. AI buckets are
   pre-seeded selectors; user topics are user-created selectors; "save search as
   topic" is just one creation entry point. This unifies all topic sources into
   one model.

3. **Topics are scarce and self-governing.** Creation has slight friction
   (explicit "follow"); removal is automatic and reversible (auto-archive on
   inactivity, auto-revive on new matches). Hard delete requires confirmation.
   Growth is bounded by design, not by manual cleanup.

4. **The unit of "weaving" is an event/story, not the broad tag.** 10 articles
   tagged "AI" may be unrelated. Coarse tags are the _entry_; inside a topic we
   re-cluster by embedding into 3–5 sub-topics ("stories"), each time-ordered.
   When there is no real structure, **degrade gracefully** to a clean
   time-ordered list — never fabricate a narrative.

5. **Crawl → walk → run on cost.** Validate the cheap structural value first
   (curated topics, embedding clustering) before paying for the uncertain,
   expensive AI synthesis (briefings, narrative sentences, dynamic topic
   discovery).

---

## Information Architecture (target)

```
Sidebar
  Smart feeds        (All / Today / Unread / Starred)   ← triage, always on top
  Topics             ← only followed topics (small, governed)
    📌 pinned…
    ◆ active…
    ⋯ Browse all topics            → catalog + discovery + create
  Feed sources       (feeds / folders)

Main content (middle column)
  Topic scope active → Topic Reading view (clusters), replaces flat timeline
  "Browse all topics" → topic catalog (full AI buckets + create + discovery)
```

Reused primitives:

- Topic scope is already a virtual feed id `topic-<label>`
  (`TOPIC_FEED_PREFIX`, `apps/desktop/layer/renderer/src/lib/timeline-scope.ts`).
- Topic entries are already filtered + time-sorted in
  `apps/desktop/layer/renderer/src/modules/entry-column/hooks/useEntriesByView.ts`
  (`useLocalEntries`, topic branch).
- The middle column already renders a **grouped** virtualized list via
  `groupedCounts: number[]` + group headers (date headers today).
- Continuous reading already exists via `getNeighbors` in
  `entry-column/context/EntriesContext.tsx`, operating on the ordered id list.
- Embeddings exist per entry:
  `packages/internal/store/src/modules/entry-embedding/` (store/hooks/job-service).

---

## Relationship to Latest / Recommended timelines

Topic reading does **not** compete with the existing Latest / Recommended
timelines. They live on two orthogonal dimensions:

| Dimension                 | What it decides                   | Options                                                                      |
| ------------------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| **Scope** (which entries) | the set of entries in the list    | All / a feed / a folder / **a topic**                                        |
| **Arrangement** (how)     | how that set is ordered/organized | **Latest** (time) / **Recommended** (rank) / **Clustered** (topic threading) |

- **Latest vs Recommended** are two _arrangements_ of whatever scope is active.
- **Topic** is a _scope_ (a filtered set), not a timeline.
- **Clustering** is a third _arrangement_, peer to Latest/Recommended, and the
  default arrangement when the scope is a topic.

So the flow is **pick a scope (sidebar) → pick an arrangement (header control)**.
They are not four competing timelines.

### Why this is architecturally consistent

Latest vs Recommended is already implemented as a transform over the same entry
id list (`recommendedTimelineEnabledAtom` → `sortEntryIdsByRecommended` in
`useEntriesByView.ts`). Clustering is the same pattern — another transform over
the id list (filter + reorder + emit `groupedCounts`):

```
Latest      = ids → sort by publishedAt desc
Recommended = ids → sort by rank score
Clustered   = ids → group by embedding + sort within group by time
```

These are composable, same-layer transforms; none replaces another.

### How they interact

- **A topic can still be viewed as Latest or Recommended.** Inside a topic the
  default arrangement is Clustered, but Latest/Recommended remain selectable. If
  a topic has no real structure, it degrades to Latest automatically.
- **Recommended can power clustering.** Clustering decides _grouping_; rank score
  can decide _which cluster floats to top_ and _intra-cluster ordering_
  (importance-first instead of pure recency) — a Recommended × Topic hybrid.
- **Non-topic scopes are unchanged.** All / feeds / folders keep only
  Latest/Recommended; clustering only applies where content is homogeneous
  enough to be worth threading (i.e. topic scope).
- **Future cross-link.** The Recommended timeline may surface a "topic card"
  (e.g. "3 new stories in AI") as an entry point into topic reading. Deferred.

### UX surface

```
Sidebar picks scope ──→ header arrangement control
  All / feed:   [Latest] [Recommended]
  Topic:        [Clustered · default] [Latest] [Recommended]
```

The `topicClusterEnabledAtom` flag (see Cross-cutting) gates the Clustered
arrangement; when off, a topic scope falls back to Latest/Recommended only.

---

## Phase 0 (optional, immediate relief)

Low-effort interim fix if Phase 1 is not started immediately. Independent and
disposable.

- Convert the sidebar Topics list from one-row-per-topic to **wrap-flow chips**
  in `TimelineScopeItems.tsx`; show an unread dot instead of a right-aligned
  count. ~70% height reduction for the fixed 10 buckets.

Skip if going straight to Phase 1 (Phase 1 supersedes this).

---

## Phase 1 — "My Topics": curated topics + governance

Goal: replace the always-on fixed bucket list with a single, small, governed
**Topics** section. No heavy AI required.

### Scope

- A persisted set of followed topics with selector = AI tag or keyword query.
- Lifecycle governance: active / dormant (auto-archived) / suggest-delete,
  derived from usage + freshness.
- Sidebar Topics block: pinned + active (sorted by recent activity), capped,
  overflow + dormant in a "Browse all topics" drawer.
- Creation entry points: from the catalog (follow an AI bucket) and from search
  ("Follow as topic"). Seed 1–2 active buckets by default.

### Data model

New store module `packages/internal/store/src/modules/topic/`
(mirroring the `entry-rank-score` store + database service pattern). MVP may
start with `atomWithStorage` and migrate to a Drizzle table later.

```ts
type TopicSelector = { type: "aiTag"; label: EntryAiTagLabel } | { type: "keyword"; query: string }
// deferred: { type: "semantic"; query: string } | { type: "manual"; entryIds: string[] }

type MyTopic = {
  id: string
  name: string
  selector: TopicSelector
  pinned: boolean
  pinnedAt?: number
  createdAt: number
  lastOpenedAt: number // drives active/dormant
  lastMatchedAt: number // last time new content matched
  // derived (not persisted): status, unreadCount
}
```

Lifecycle (computed at read time, not stored):

- **active**: opened within 4 weeks **or** new match within 2 weeks → shown in sidebar
- **dormant**: otherwise → drops into "Browse all topics" drawer (kept, reversible)
- **revive**: dormant topic gets a new match → returns to active
- **suggest-delete**: dormant ≥ 8 weeks with zero activity → cleanup suggestion (still needs confirm)

Defaults to confirm: active rows cap = 6, dormant threshold = 4w,
suggest-delete = 8w, promotion is always manual.

### Matching

- `aiTag` → reuse existing tag filter (`tagsByEntryId[id].some(...)`).
- `keyword` → **title-only** substring match over entries (cheap, no AI). Phase 1
  deliberately skips body matching: it is expensive and content is often not
  loaded. Keyword topics are **upgraded to semantic matching in Phase 2** once
  embeddings are wired (see Phase 2 Scope), which is both more accurate and
  cheaper than scanning full bodies.
- semantic/manual selectors → deferred.

### Files

Add:

- [ ] `packages/internal/store/src/modules/topic/store.ts` — topic store + actions (CRUD, pin, touch `lastOpenedAt`/`lastMatchedAt`).
- [ ] `packages/internal/store/src/modules/topic/hooks.ts` — `useMyTopics()`, `useTopicLifecycle()` (derived active/dormant + sort).
- [ ] `packages/internal/store/src/modules/topic/selector.ts` — `matchEntry(selector, entry, tags)` pure fn + tests.
- [ ] (if persisted) database service + migration mirroring `entry_rank_scores`.
- [ ] `apps/desktop/.../subscription-column/subscription-list/MyTopicsSection.tsx` — sidebar block (pinned/active rows, hover pin/archive, overflow).
- [ ] `apps/desktop/.../subscription-column/BrowseTopicsModal.tsx` — catalog: AI buckets + create-keyword + dormant list + cleanup.

Change:

- [ ] `TimelineScopeItems.tsx` — remove the fixed bucket list; render `MyTopicsSection` instead; keep smart feeds.
- [ ] `timeline-scope.ts` — extend topic feed id to also encode keyword topics (e.g. `topic-kw:<id>`), or route keyword topics through topic id; keep `aiTag` path intact.
- [ ] `useEntriesByView.ts` (`useLocalEntries`) — resolve keyword/custom selectors to an entry id set (aiTag path already works).
- [ ] Search result surface — add "Follow as topic" action (creates a `keyword` topic). (Depends on existing search UI.)

### Validation

- [ ] Unit: `selector.matchEntry` (aiTag + keyword), lifecycle derivation.
- [ ] `pnpm typecheck && pnpm lint:fix && pnpm test`.
- [ ] Manual: follow/unfollow, pin ordering, auto-archive after threshold,
      revive on new match, sidebar height < current.

### Deferred to later phases

Rich topic catalog page, semantic/manual selectors, the clustered reading view.

---

## Phase 2 — Topic Reading view (embedding clustering)

Goal: entering a topic shows a clustered, time-threaded reading session.
**No new LLM calls.**

### Scope

- Cluster a topic's entries into sub-topics via embeddings.
- **Upgrade `keyword` selectors to semantic matching**: embed the query and match
  by vector similarity instead of the Phase 1 title substring, so keyword topics
  surface relevant entries that don't literally contain the term.
- Cluster header: title + `N articles · M sources · latest Xh ago`, collapse,
  mark-cluster-read.
- Within-cluster order = chronological (ascending) to read as a story.
- Near-duplicate merge ("same event · N reports").
- Three states: analyzing (embeddings still backfilling → show time list first),
  graceful degrade (low structure → clean time list), sparse (≤2 → flat list).
- Time window selector (Today / This week / This month / All), default week.
- Continuous reading across clusters (free via `getNeighbors`).

Excluded (Phase 3): one-line "thread" sentence per cluster, top-of-view briefing.
Cluster title in Phase 2 = title of the entry nearest the cluster centroid
(truncated), no LLM.

### Algorithm

Pure function, cosine threshold + connected components (union-find), single-link:

- form clusters when pairwise cosine ≥ `τ ≈ 0.82`; `minSize = 2`; singletons → "Misc".
- near-duplicate merge at higher `τ_dup ≈ 0.93` → collapse to "same event".
- Degrade falls out for free: if nothing exceeds `τ`, all items are singletons →
  a single time-ordered list.
- Cost: N ≤ few hundred, O(N²·d), memoized; move to a worker only if needed.

```ts
type EntryCluster = {
  id: string
  title: string // centroid-nearest entry title
  entryIds: string[] // time ascending (the thread)
  sourceFeedIds: string[]
  latestPublishedAt: number
  size: number
}
```

### Files

Add:

- [ ] `packages/internal/store/src/modules/entry-embedding/cluster.ts` — `clusterEntries(items, opts) => EntryCluster[]`.
- [ ] `packages/internal/store/src/modules/entry-embedding/cluster.test.ts` — cluster count / degrade / dedup determinism.
- [ ] `apps/desktop/.../entry-column/hooks/useTopicClusters.ts` — read topic `entriesIds` + vectors from `useEntryEmbeddingStore`, run clustering (memo by topic+window+id-set hash); return `orderedEntryIds`, `groupedCounts`, `clusters`, `coverage`, `analyzing`.
- [ ] `apps/desktop/.../entry-column/components/TopicClusterHeader.tsx` — cluster group header.
- [ ] `apps/desktop/.../entry-column/components/TopicAnalyzingBanner.tsx` — analyzing state.
- [ ] `apps/desktop/.../entry-enrichment/trigger.ts` → add `triggerEntryEmbeddingBackfill` (calls `entryEmbeddingJobService.backfillVisible`).

Change:

- [ ] `entry-column/index.tsx` — in topic scope, feed `orderedEntryIds` /
      `groupedCounts` from `useTopicClusters` and render `TopicClusterHeader`
      for group headers.
- [ ] `entry-column/list.tsx` — expose a `renderGroupHeader` slot (today the
      grouped list hardcodes `DateItem`); swap to `TopicClusterHeader` when
      clustering is active. **This is the only existing component that needs
      structural change — verify before implementing.**
- [ ] Trigger embedding backfill for topic entries (so new topics have vectors).
- [ ] Time window atom + selector in the topic header.

Reused for free: neighbor navigation, scroll mark-read, virtualization,
opening an entry in the right column.

### Validation

- [ ] Unit: `cluster.ts` (determinism, degrade, dedup).
- [ ] `pnpm typecheck && pnpm lint:fix && pnpm test`.
- [ ] Manual: topic with vectors → clusters; new topic → analyzing → reflow;
      ≤2 entries → flat; continuous reading walks clusters.

### Cost layering (within Phase 2)

| Capability                         | Dependency                 | Cost |
| ---------------------------------- | -------------------------- | ---- |
| Meta (N articles / sources / time) | pure compute               | free |
| Sub-topic clustering + threading   | existing embeddings        | free |
| Cluster title                      | centroid-nearest title     | free |
| Near-duplicate merge               | embedding similarity       | free |
| Thread sentence / briefing         | new LLM call → **Phase 3** | paid |

---

## Phase 3 — AI synthesis + dynamic topic discovery

Goal: layer the expensive, high-value AI on top of the validated structure.

### Background: why this phase exists (verified)

Phase 2 whole-document embeddings cluster digest-style articles by **format +
source**, not by a specific shared topic. Verified on the live "Fable" topic with
real vectors:

- The two clustered articles were both daily digests from the **same feed**
  (`uniqueFeeds=1`); `cos = 0.8397`, only just above `tau = 0.82`.
- A "misc" (uncategorized) article sat at `cos = 0.7347` — almost as close as the
  in-cluster pair. The cluster boundary is format-driven, not event-driven.

Two axes are conflated and must be separated:

- **Topic / sub-event axis** (what it's about) → embeddings do this well, but
  whole-doc dilutes digests. Fix: **fragment-level embedding** (Track B).
- **Genre / intent axis** (intro / hands-on / analysis / opinion …) → embeddings
  do this **poorly** (same topic, different rhetoric → near-identical vectors).
  Fix: **LLM classification**, piggybacked on the existing tags call (Track A).

Track A is the true minimum and ships first; Track B is heavier and deferred.

---

### Phase 3a — Content-type (genre) facet [minimal, ship first]

A single genre label per entry, produced by the **same** LLM call that already
generates AI tags (`generateLocalByokTags` → one `/chat/completions`). **Zero new
requests, zero added LLM cost** (only a slightly longer prompt + response).

Working label set (8, keep tight): `快讯 | 合集 | 教程 | 实测 | 分析 | 观点 | 论文 | 其他`.
`合集` is mandatory (lets us special-case digests); `其他` is the low-confidence
fallback. Keep this axis pure — sentiment, media type, topic, length are separate
axes and must NOT be folded in.

#### Data / contract

- [ ] `packages/internal/shared/src/entry-ai-tags.ts` — add
      `ENTRY_CONTENT_TYPE_CANDIDATES` + `EntryContentType` +
      `EntryContentTypeAssignment` (`{ label, confidence }`).
- [ ] `packages/internal/database/src/schemas/index.ts` — add nullable columns
      `contentType text` + `contentTypeConfidence real` to `entryAiTagsTable`
      (1:1 with entryId, no new table).
- [ ] Generate migration: `pnpm --filter @follow/database generate` → new
      `0042_*.sql` + journal. Safe on existing DBs: the runtime migrator
      (`shouldSkipMigrationQuery`) auto-skips `ADD COLUMN` if it already exists.
- [ ] `packages/internal/database/src/services/entry-ai-tags.ts` — write
      `contentType` in `upsertTags` and add it to the `onConflictDoUpdate.set`.
- [ ] `packages/internal/store/src/context.ts` — extend `TagGeneratorResult` with
      `contentType?: { label: string; confidence: number } | null`.

#### LLM piggyback (the "no added cost" part)

- [ ] `apps/desktop/layer/renderer/src/modules/ai/local-byok-tags.ts` — extend the
      prompt's JSON shape to also return `contentType` (one label from the
      whitelist + confidence) alongside `tags`; parse and return it. **Same single
      call** — no second request.

#### Store / validation

- [ ] `packages/internal/store/src/modules/entry-tags/utils.ts` — add
      `validateContentType` (whitelist check, clamp confidence, fallback `其他`).
- [ ] `packages/internal/store/src/modules/entry-tags/store.ts` — add
      `contentType` map to `EntryAiTagsState`; hydrate + upsert carry it;
      `generateTags` passes it through; add `getContentType` + `useEntryContentType`.
- [ ] `packages/internal/store/src/modules/enrichment/service.ts` — in
      `isPhaseMissing("tags")`, also treat "has tags but no contentType" as
      missing so already-tagged entries backfill on the next pass (else they only
      get it via rescore).

#### UI (consume)

- [ ] `apps/desktop/.../entry-column/atoms/topic-cluster.ts` — add
      `topicContentTypeFilterAtom` (default `all`).
- [ ] `apps/desktop/.../entry-column/components/topic-cluster/TopicContentTypeFilter.tsx`
      (new) — chip row (`全部` + 8 types), shown only in mytopic scope.
- [ ] `apps/desktop/.../entry-column/hooks/useTopicClusters.ts` (or a sibling
      hook) — filter `entryIds` by the selected contentType (using the store map)
      **before** clustering, then recompute `groupedCounts`.
- [ ] `apps/desktop/.../entry-column/index.tsx` — render the filter row above the
      list in topic scope.
- [ ] i18n: 8 labels + "全部" in `en` / `zh-CN` / `ja` (flat keys, no defaultValue).

#### Validation

- [ ] `contentType` persisted + hydrated; survives reload.
- [ ] Newly enriched + previously-tagged entries both get a contentType.
- [ ] Filter chips narrow the topic list correctly; `全部` restores; empty type
      shows an empty state, not a crash.
- [ ] No extra `/chat/completions` calls vs. before (verify in network log).

---

### Phase 3b — Fragment-level embedding [heavier, deferred]

Embedding API is free for this project, so the cost blocker is removed — but
local compute/storage are not (vectors ×N per article, O(n²) clustering). Gate
behind a flag and cap fragments. Treat as a follow-on after 3a proves the facet.

- [ ] `packages/internal/store/src/modules/entry-embedding/source-text.ts` — add
      `buildEmbeddingFragments(entry)` (split by headings/paragraphs, cap N, drop
      boilerplate); only embed topic-relevant fragments.
- [ ] Schema: fragments are 1:N → new `entry_embedding_fragments` table
      (`entryId, idx, vector, sourceHash`) + migration. (Or store a vector array
      on the existing row; a child table is cleaner for partial backfill.)
- [ ] `entry-embedding/job-service.ts` + `store.ts` — embed/store multiple vectors
      per entry; keep async backfill semantics.
- [ ] `entry-embedding/cluster.ts` — cluster at fragment granularity, then roll up
      to entries (entry joins a cluster if any fragment exceeds `tau`); dedup.
- [ ] Re-verify on the "Fable" topic that same-source digests no longer over-merge
      and that real Fable sub-events cluster cleanly.

---

### Phase 3c — AI synthesis + dynamic discovery [original scope, last]

- **Per-cluster thread sentence**: a one-line "how these connect" summary.
- **Topic briefing**: a collapsible top-of-view overview of the whole topic for
  the window (main lines, consensus/disagreement), with an "may be inaccurate"
  note.
- **Dynamic topic discovery**: cluster embeddings across the corpus to surface
  emergent topics beyond the fixed buckets; LLM labels the clusters; suggest as
  follow candidates. Handle cluster drift / stability.
- **Semantic topics**: `semantic` selector — embed the query, match by cosine.

### Design constraints

- All LLM outputs are **cached** by `topic + window` (and invalidated on new
  matches); never recompute on every open.
- LLM features are **isolated and optional**: if generation fails or is disabled,
  Phase 2 clustering + lists still fully work.
- Surface uncertainty explicitly (label as AI-generated, "may be inaccurate").

### Files (indicative — 3c synthesis)

- [ ] `packages/internal/store/src/modules/enrichment/service.ts` — add a topic
      briefing/thread phase, or a separate topic-summary service mirroring
      `summarySyncService`.
- [ ] Briefing cache store + (optional) DB table keyed by `topic+window`.
- [ ] Topic discovery job (corpus clustering + LLM labeling) reusing the
      embedding job-service queue pattern.
- [ ] UI: cluster thread sentence in `TopicClusterHeader`, briefing panel in the
      topic header, discovery suggestions in `BrowseTopicsModal`.

### Validation

- [ ] Cache hit/miss + invalidation on new content.
- [ ] Graceful failure (LLM off/error) → Phase 2 view intact.
- [ ] Cost telemetry on briefing/labeling calls.

---

## Cross-cutting

### Feature flags

- Gate Phase 2/3 behind `topicClusterEnabledAtom` (or under `useFeature("ai")`),
  matching existing `aiTimelineEnabledAtom` / `recommendedTimelineEnabledAtom`
  patterns. Disabling reverts to the flat topic timeline.

### Caching

- Phase 2 clustering: in-memory memo keyed by `topic + window + id-set hash`,
  recompute only on set change.
- Phase 3 LLM: persistent cache keyed by `topic + window`, invalidated on new
  matches.

### Coverage / async embeddings

Embeddings backfill asynchronously (`entryEmbeddingJobService`). The reading
view must always render a usable time-ordered list first and reflow into
clusters when coverage improves — never block on a spinner.

---

## Open questions / defaults to confirm

- Sidebar active-topic cap (default 6), dormant threshold (4w), suggest-delete
  (8w).
- Whether keyword topics persist locally only or sync (Phase 1 local-first).
- Clustering thresholds `τ` (0.82) and `τ_dup` (0.93) — tune on real data.
- Whether "Browse all topics" is a modal (Phase 1) or a full topic-mode page
  (later).
- Whether to ship Phase 0 chips as interim relief.

---

## Appendix: key wireframes

Sidebar Topics (Phase 1):

```
Topics                     +
  📌 Claude Code      5
  ◆ AI               77      ← followed bucket
  ◆ Products         70
  ⋯ Browse all topics        ← rest of buckets + create + discovery
```

Topic reading (Phase 2):

```
Topic: AI            This week ⌄ · 38 · ✓ mark all
  📋 Overview (Phase 3, collapsed)                 ⌄
  ● GPT-5 launch & reception   6 · 4 src · 2h    ⌃
    ┊ 09:10  OpenAI   GPT-5 released…
    ┊ 11:32  HN       doubts on benchmarks…
    show 3 more ⌄                  ✓ mark cluster read
  ● Open-model catch-up        5 · 3 src · 5h    ⌃
  ● AI coding tools            4              ⌄
  ─ Misc (unclustered) 3 ───────────────────
```
