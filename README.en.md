<div align="center">

[中文](./README.md) · **English**

<h1>📰 FinHot · Financial Feed Reader</h1>
  <p><strong>A local-first financial RSS reader</strong></p>
  <p>Aggregates financial RSS, Weibo, Xueqiu and X; auto scoring, summaries and Chinese translation for focused reading</p>
</div>

<p align="center">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="license"/>
  <img src="https://img.shields.io/badge/based_on-Focal_(Folo_fork)-orange" alt="base"/>
</p>

<p align="center">
  <img src="./docs/screenshots/timeline.png" alt="FinHot timeline UI" width="920"/>
</p>

---

## What it is

FinHot is built on [Focal](https://github.com/nextcaicai/Focal) (a fork of [Folo/RSSNext](https://github.com/RSSNext/Folo)), reusing its mature RSS subscription engine, local SQLite database, BYOK AI enrichment framework, and Electron desktop shell. It is a **financial feed reader**:

- 📡 **Multi-source aggregation** — RSS financial sources + custom Weibo / Xueqiu / WeChat / X watchlists
- ⭐ **Quality scoring** — server-side enrichment scores and ranks entries, filtering low-signal noise
- 📝 **AI summaries** — auto-generates Chinese summaries per entry (BYOK, using your own LLM key)
- 🌐 **AI translation** — auto-translates titles and bodies of English/foreign entries into Chinese
- 🖥️ **Desktop + Web** — macOS/Windows/Linux desktop app, also deployable as a public site, local-first

<p align="center">
  <img src="./docs/screenshots/entry-detail.png" alt="Entry detail: original + AI summary" width="920"/>
</p>

## Architecture

```
Electron (desktop shell)
├── Renderer (Vite + React)
│   ├── RSS timeline (Smart Feeds)
│   ├── Entry detail (original / AI summary / AI translation)
│   └── Subscription & group management
├── Main Process
│   ├── Scheduled RSS ingestion
│   ├── Server-side enrichment (scoring / summary / translation)
│   └── Local SQLite (Drizzle ORM)
└── Shared Packages
    ├── @follow/components (UI component library)
    ├── @follow/utils (utilities)
    └── @follow/database (data layer)
```

## Quick start

```bash
# Install dependencies
pnpm install

# Dev mode (browser, recommended)
cd apps/desktop && pnpm run dev:web

# Full Electron dev
cd apps/desktop && pnpm run dev:electron

# Build
pnpm run build:web
```

## Acknowledgements

- [Focal](https://github.com/nextcaicai/Focal) — local-first RSS reader
- [Folo (RSSNext)](https://github.com/RSSNext/Folo) — upstream RSS platform

## License

[AGPL-3.0](./LICENSE)
