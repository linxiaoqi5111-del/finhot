# AGENTS.md

## 🧠 共享记忆底座（开工前先读）

本机有一个跨 Agent 共享的记忆底座（Obsidian vault）：`/Users/a77/agent-memory`（仓库 `linxiaoqi5111-del/agent-memory`）。

**开始任务前先读：**

- `30_conventions/preferences.md` — 用户偏好与人设（教学模式：讲原理 + 讲技术选型/替代方案对比 + 标注可复用知识点；Git 约定；红线）
- 本项目对应笔记 `20_projects/finhot.md` — 项目背景、关键决策、任务看板

**完成后回写：** 把关键结论/决策追加到 `20_projects/finhot.md` 的「交接记录」，可复用知识提炼进 `10_knowledge/`。

This file provides concise, agent-focused guidance for working in this monorepo. It consolidates the repository's CLAUDE.md guides, .cursor rules, Cursor rules improvements, and modern agent best practices.

## Git branch safety (mandatory)

`main` is the shared baseline. **Every code/config change must start on a task branch** — never edit `main` directly.

At session start, report:

```bash
git status --short
git branch --show-current
```

Workflow:

1. `git checkout main` → `git pull` → `git checkout -b <type>/<short-task>`
2. Work → commit → push branch
3. Merge to `main` only after user explicitly confirms

Branch naming: `fix/<issue>`, `feature/<name>`, `data-source/<name>`, `theme-radar/<name>`.

Do **not** commit on `main` for: rss-proxy / public reader changes, watchlist pipeline, deploy scripts, DuckDB or cache logic, or any multi-file feature work.

Small doc-only typo fixes on `main` are OK if zero runtime risk.

Before commit, never stage: `.env*`, `*.pdf`, `*.duckdb`, `*.db`, `.finhot-cache/`, `node_modules/`, credentials.

Canonical local path: **`~/finhot`** (single repo; do not duplicate under `~/Desktop/finhot` or `~/khazix-skills`).

## Project overview

- Desktop-focused monorepo managed by pnpm workspaces + Turbo.
- App:
- `apps/desktop` – Electron app (Vite + React renderer is the primary web app)
- Shared packages: `packages/internal` (components, atoms, hooks, store, utils, database, etc.).

## Setup commands

```bash
# Install deps
pnpm install

# Desktop – recommended (browser renderer)
cd apps/desktop && pnpm run dev:web

# Desktop – full Electron
cd apps/desktop && pnpm run dev:electron

# Build web version (desktop renderer)
pnpm run build:web
```

## Quality gates (must-pass before commit/PR)

```bash
# 1) Typecheck first (required)
pnpm run typecheck

# 2) Lint and auto-fix
pnpm run lint:fix

# 3) Tests
pnpm run test
```

- Run the above at the root, or use per-package variants as needed.
- Follow this order strictly: typecheck → lint → test.
- After every modification, run the following checks to catch errors early:

```bash
npm exec turbo run format:check typecheck lint
npm exec turbo run test
```

## Code style and conventions

- TypeScript strict; avoid `any` (use precise types). Comments in English. Keep solutions simple and maintainable.
- Prefer CSS transitions/animations for simple UI interactions. Use JS-driven motion only when necessary to avoid frame drops.
- Imports: use `pathe` instead of `node:path` for cross‑platform paths.
- Organize shared, reusable UI in `packages/internal/components`; app-specific UI stays in its app.
- **Style extraction**: Avoid inline styles in JSX. Extract complex styles (especially those using CSS variables, gradients, or multiple properties) to external style objects similar to React Native's `StyleSheet.create`. Place style objects in a `styles.ts` file alongside the component, using `CSSProperties` type for type safety.

## Team preferences

- Prefer CSS transitions/animations over JS-based motion for simple interactions to avoid frame drops.
- Prefer simple, easy-to-maintain solutions.
- Avoid using the `any` type in TypeScript.
- Write code comments in English.

## Architecture quick reference

- State: Jotai for atoms, Zustand for complex stores, TanStack Query for server state.
- Database: Drizzle + SQLite (see `packages/internal/database`).
- Error handling: custom utils in `packages/internal/utils`; Sentry integrated.
- i18n: i18next with flat keys only; no `defaultValue`. Provide `en`, `zh-CN`, `ja` for each feature. Avoid conflicting dotted keys.

## UI system and design tokens

### Tailwind + Apple UIKit colors (Desktop/Web)

- Use Tailwind classes bound to Apple UIKit color tokens (light/dark adaptive). Prefix by CSS property:
  - System colors: `text-red`, `bg-blue`, `border-gray`, etc. for `red|orange|yellow|green|mint|teal|cyan|blue|indigo|purple|pink|brown|gray`.
  - Fill: `bg-fill[-secondary|-tertiary|-quaternary|-quinary]` and `bg-fill-vibrant[-secondary|-tertiary|-quaternary|-quinary]` (and `border-*` as needed).
  - Text: `text-text`, `text-text-secondary|tertiary|quaternary|quinary`, `text-text-vibrant(-secondary|-tertiary|-quaternary|-quinary)`.
  - Material: `bg-material-ultra-thick|thick|medium|thin|ultra-thin|opaque`.
  - Control: `bg-control-enabled|disabled`.
  - Interface: `bg-menu|popover|titlebar|sidebar|selection-focused|selection-focused-fill|selection-unfocused|selection-unfocused-fill|header-view|tooltip|under-window-background`.

These classes map to the UIKit color variables (see `.cursor rules/color` and `apps/desktop/AGENTS.md`).

### Icons (Desktop/Web)

- Do not add or copy MingCute Pro assets into the repository. Do not create `icons/mgc`, `i-mgc-*`, or `*-cute-*` icon names.
- For local product UI icons, use the Focal icon set (`i-focal-*`) generated from redistributable sources in `icons/focal`.
- For new generic UI icons, use Lucide-backed `i-focal-*` icons. Lucide state icons use stroke color plus background/container state, not filled icon variants.
- For AI/LLM provider and model brand marks, use `@lobehub/icons-static-svg` via the local `i-focal-*` wrapper. For non-AI third-party brands, use `simple-icons` or `logos` sources through `i-focal-*` when local wrapping is needed.
- Focal-owned identity assets (app logo, mascot, Power token, favicon/PWA/Electron icons) must be designed or generated from Focal-owned source artwork, not copied from Folo or MingCute Pro.

### Motion (Desktop/Web)

- Use Framer Motion with LazyMotion via `m` from `motion/react` (e.g., `m.div`).
- Prefer spring presets from `@follow/components/constants/spring.js` (`Spring.presets.smooth|snappy|bouncy`).
- For simple micro-interactions, prefer CSS transitions first.

## Component placement

1. Check existing components in `apps/desktop/layer/renderer/src/modules/renderer/components` for app-specific UI.
2. If generic and reusable, implement in `packages/internal/components` and export from the package index.

## Testing & CI tips

- Use Vitest for unit tests; co-locate tests near source files.
- After moving files or changing imports, run `pnpm lint` and `pnpm typecheck` for the affected package.
- CI expects `pnpm typecheck`, `pnpm lint`, and `pnpm test` to pass before merge.

## Agent workflow (Cursor-oriented improvements)

- Status updates: provide brief progress notes when running tool batches.
- Prefer semantic code search to explore unfamiliar areas; use exact grep only for symbols.
- Default to parallelizing independent searches/reads to reduce latency.
- Avoid multi-line speculative edits; keep edits minimal and targeted; preserve existing indentation.
- When editing TypeScript, do not introduce `any`; keep types precise.
- For UI, prefer CSS transitions for simple effects; use Framer Motion `m.*` only when needed.

## Context7 (up-to-date docs)

- Use Context7 to fetch current library docs before using APIs prone to change.
- Workflow:
  1. Resolve a library ID: resolve the library (e.g., React Native, Vite, TanStack Query).
  2. Fetch docs scoped to the topic (e.g., hooks, routing).
  3. Integrate code examples following our style rules.

## Sequential Thinking (step-by-step problem solving)

- Break work into small thought steps:
  1. Define immediate goal/assumption.
  2. Use suitable tool (search, code edit, error explainer, docs).
  3. Record the output/results.
  4. Decide next step or branch alternatives; compare trade-offs.
- Encourage rollback/iteration if new information contradicts prior steps.

## Subproject guides

- This root AGENTS.md sets global rules. Each app/package should include its own `AGENTS.md` (e.g., `apps/desktop/AGENTS.md`, `apps/mobile/AGENTS.md`). The closest guide to the edited file takes precedence when rules conflict.

## Quick checklists

- Implementation
  - [ ] Is code placed in the right package/app?
  - [ ] Type-safe (no `any`), readable names, English comments where needed.
  - [ ] Uses correct UIKit Tailwind tokens and icon sources.
  - [ ] For motion: CSS first; `m.*` only if necessary.

- Validation
  - [ ] `pnpm typecheck` passes
  - [ ] `pnpm lint:fix` passes cleanly
  - [ ] Tests updated and pass
