---
name: finhot
description: Access FinHot curated financial news feeds — RSS, JSON API, and detail pages. Use this skill to query selected/filtered financial news, hot topics, and daily digests programmatically.
---

# FinHot — AI-Curated Financial News

FinHot is an AI-powered financial news aggregator that processes multi-source feeds (Weibo, Xueqiu, Twitter, WeChat) through local AI enrichment (summarization, translation, scoring, embedding clustering) and exposes curated results via public endpoints.

## Architecture

```
Sources (RSSHub/Playwright/nitter)
  → Local AI pipeline (summary, translation, 6-dim scoring, embedding)
  → .finhot-cache/ (manifest.json, entries/*.json, enrichments.json)
  → Public endpoints (HTML, RSS, JSON API)
```

All AI processing happens locally. Public endpoints only render pre-computed results.

## Access Points

### Web UI

- **Public page**: `/public` — Full reader UI with 精选/全部/热点 views
- **Detail page**: `/items/<id>` — Standalone permalink for sharing (includes 精选理由, AI摘要, 翻译, 评分明细, 相关报道)

### RSS Feeds

| Endpoint          | Content                  | Use case                       |
| ----------------- | ------------------------ | ------------------------------ |
| `/feed.xml`       | 精选 (qualityScore ≥ 70) | RSS reader, daily curated feed |
| `/feed/all.xml`   | All entries              | Full firehose                  |
| `/feed/daily.xml` | Today's digest           | Daily briefing                 |

### JSON API

All API endpoints return JSON with `Access-Control-Allow-Origin: *`.

#### `GET /api/public/items`

Paginated item list with enrichment data.

**Parameters:**
| Param | Default | Description |
|-------|---------|-------------|
| `filter` | `selected` | `selected` / `watch` / `all` |
| `since` | — | ISO date, return items after this time |
| `q` | — | Full-text search (title, summary, tags) |
| `category` | — | Filter by feed category |
| `limit` | 50 | Max items (capped at 500) |

**Response:**

```json
{
  "items": [
    {
      "id": "...",
      "title": "...",
      "url": "...",
      "publishedAt": "...",
      "author": "...",
      "feedTitle": "...",
      "feedCategory": "微博",
      "summary": "AI-generated content summary",
      "recommendationReason": "Why this is worth reading",
      "qualityScore": 82,
      "selected": "selected",
      "tags": ["macro", "央行"],
      "translation": null,
      "clusterId": "...",
      "relatedEntryIds": ["...", "..."]
    }
  ],
  "total": 12,
  "filter": "selected"
}
```

#### `GET /api/public/item/<id>`

Single item full detail including content body, qualityDetails, and related entries.

**Response:**

```json
{
  "id": "...",
  "title": "...",
  "content": "<html content>",
  "summary": "...",
  "recommendationReason": "...",
  "qualityScore": 82,
  "selected": "selected",
  "qualityDetails": {
    "scores": {
      "information_gain": 4,
      "depth": 4,
      "evidence": 5,
      "actionability": 3,
      "originality": 4,
      "signal_density": 5
    },
    "positiveReasons": ["..."],
    "negativeReasons": ["..."],
    "confidence": 0.82
  },
  "relatedEntries": [{ "id": "...", "title": "...", "feedTitle": "...", "qualityScore": 75 }]
}
```

#### `GET /api/public/topics`

Hot topic clusters (multi-source event aggregation).

**Response:**

```json
{
  "topics": [
    {
      "id": "cluster-xxx",
      "title": "Representative headline",
      "entries": ["id1", "id2", "id3"],
      "sourceCount": 3,
      "avgQualityScore": 78,
      "latestAt": "..."
    }
  ]
}
```

#### `GET /api/public/daily`

Today's digest grouped by selection tier.

**Parameters:**
| Param | Default | Description |
|-------|---------|-------------|
| `date` | today | ISO date (YYYY-MM-DD) |

**Response:**

```json
{
  "date": "2024-01-15",
  "totalEntries": 45,
  "selected": [...],
  "watch": [...]
}
```

## Selection Tiers

| Tier       | qualityScore | Display  | Meaning             |
| ---------- | ------------ | -------- | ------------------- |
| `selected` | ≥ 70         | 精选 82  | High-value, curated |
| `watch`    | 40–69        | 观察 61  | Worth monitoring    |
| `noise`    | < 40         | (hidden) | Low signal          |

## Quality Score Dimensions (6-axis)

1. **information_gain** — Net new information vs. known
2. **depth** — Analysis depth and reasoning
3. **evidence** — Supporting data/facts quality
4. **actionability** — Investability / decision-readiness
5. **originality** — First-mover or unique angle
6. **signal_density** — Ratio of signal to filler

## Key Differences from Summary

- **recommendationReason** = "Why this is worth reading" (selection rationale)
- **summary** = "What the content says" (content digest)

These are intentionally separate fields. An agent should use `recommendationReason` to decide relevance, and `summary` for content understanding.

## Data Sources

| Source    | Method                          | Config                                                 |
| --------- | ------------------------------- | ------------------------------------------------------ |
| Weibo     | RSSHub `/weibo/user/{uid}`      | Docker localhost:1200                                  |
| Xueqiu    | Playwright headful Chrome       | Cookie injection, profile at `~/.finhot/xq-pw-profile` |
| Twitter/X | RSSHub `/twitter/user/{handle}` | `TWITTER_AUTH_TOKEN` in Docker env                     |
| WeChat    | wechat2rss proxy                | License-bound, separate machine                        |

## Cache Structure

```
.finhot-cache/
├── manifest.json          # Feed registry + metadata
├── entries/
│   └── {feedId}.json      # Entries per feed
└── enrichments.json       # AI results keyed by entry ID
```

## Typical Agent Workflow

```python
# 1. Get today's curated items
GET /api/public/items?filter=selected&since=2024-01-15

# 2. Check hot topics
GET /api/public/topics

# 3. Get detail for interesting item
GET /api/public/item/{id}

# 4. Subscribe to curated RSS
# Add /feed.xml to any RSS reader
```
