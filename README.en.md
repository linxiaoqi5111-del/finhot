<div align="center">

[中文](./README.md) · **English**

<h1>🔥 FinHot · Financial Hot-Word Radar</h1>
  <p><strong>A local-first financial information monitoring platform</strong></p>
  <p>Track sudden hot words in financial news flashes, quantify heat and speculation intensity</p>
</div>

<p align="center">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="license"/>
  <img src="https://img.shields.io/badge/based_on-Focal_(Folo_fork)-orange" alt="base"/>
  <img src="https://img.shields.io/badge/status-Phase_0-green" alt="status"/>
</p>

---

## What it is

FinHot is built on [Focal](https://github.com/nextcaicai/Focal) (a fork of [Folo/RSSNext](https://github.com/RSSNext/Folo)), reusing its mature RSS subscription engine, local SQLite database, BYOK AI enrichment framework, and Electron desktop shell, and focusing on the **financial hot-word monitoring** scenario:

- 📡 **Multi-source ingestion** — RSS financial flashes + Weibo/Xueqiu watchlists
- 🔥 **Hot-word engine** — tokenization + n-gram + burst detection + heat scoring
- 📊 **A-share speculation intensity** — automatically flags hot words carrying speculation signals
- 📰 **Financial brief** — AI-generated daily picks
- 🖥️ **Desktop app** — macOS/Windows/Linux, local-first

## Architecture

```
Electron (desktop shell)
├── Renderer (Vite + React)
│   ├── Hot-word dashboard (trend charts / burst words / speculation intensity)
│   ├── RSS timeline (Smart Feeds: regulation / product / industry / research / opinion)
│   └── AI brief panel
├── Main Process
│   ├── Scheduled RSS ingestion
│   ├── Hot-word analysis engine
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

## Roadmap

- [x] Phase 0: Focal base + branding customization
- [ ] Phase 1: Preset financial RSS sources
- [ ] Phase 2: Hot-word analysis engine (TypeScript)
- [ ] Phase 3: Financial dashboard UI
- [ ] Phase 4: AI brief + recommendation ranking

## Acknowledgements

- [Focal](https://github.com/nextcaicai/Focal) — local-first RSS reader
- [Folo (RSSNext)](https://github.com/RSSNext/Folo) — upstream RSS platform
- [finhot (zycyyyya)](https://github.com/zycyyyya/finhot) — financial hot-word Agent Skill inspiration

## License

[AGPL-3.0](./LICENSE)
