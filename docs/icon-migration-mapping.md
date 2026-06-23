# Icon Migration Mapping — Focal Icon Set

> 目的：移除 MingCute Pro / Folo 视觉资产的二次分发风险，同时避免 `mgc`、`cute` 等旧命名误导后续维护者。

## 当前策略

| 类别                   | 规则                                                                          | 原因                                   |
| ---------------------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| 通用 UI 图标           | 默认使用 Lucide，经 `icons/focal/*.svg` 暴露为 `i-focal-*`                    | Lucide 更轻、更圆，更接近系统 UI 视觉  |
| 状态 / fill 图标       | 使用 Lucide stroke + 颜色/背景/容器状态，不再追求 filled icon                 | 避免为了 fill 态继续混入第二套图标风格 |
| AI/LLM 品牌图标        | 使用 `@lobehub/icons-static-svg`，仍通过 `i-focal-*` 本地包装                 | AI provider/model 需要准确品牌识别     |
| 通用第三方品牌         | 使用 `simple-icons` / `logos` 来源，必要时通过 `i-focal-*` 本地包装           | 品牌图标不能用通用图标库或手绘替代     |
| Focal 品牌             | 使用 Focal 自有源图                                                           | 包括 app icon、Focal AI、Power token   |
| 旧命名 / 旧 collection | `icons/mgc`、`i-mgc-*`、`i-mingcute-*`、`i-ph-*`、`*-cute-*` 不再用于业务代码 | 避免误以为仍在分发 MingCute/Phosphor   |

## 落地方式

- 本地图标目录：`icons/focal`
- Tailwind collection：`focal`
- 使用方式：`i-focal-add`、`i-focal-add-fill`、`i-focal-focal-ai`
- 生成脚本：`pnpm icons:update`
- 旧名称清单：`scripts/icon-legacy-names.json`，仅用于从旧调用名生成新语义名，不是图标资产目录。

## 实际缺口核对

原先 `E. 缺口` 中的图标并非都已废弃。当前正式代码使用情况如下：

| 旧缺口项                 | 当前类名                 | 实际位置                                                                                                                                                                                               | 处理                                               |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `paint-brush-ai-cute-re` | `i-focal-paint-brush-ai` | `apps/desktop/layer/renderer/src/modules/entry-content/components/EntryPlaceholderLogo.tsx`；`apps/desktop/layer/renderer/src/modules/entry-column/layouts/EntryListHeader.tsx`                        | Lucide `paintbrush`，不自绘                        |
| `refresh-4-ai-cute-re`   | `i-focal-refresh-4-ai`   | `apps/desktop/layer/renderer/src/modules/entry-content/components/EntryPlaceholderLogo.tsx`；`apps/desktop/layer/renderer/src/modules/entry-column/layouts/EntryListHeader.tsx`                        | Lucide `refresh-cw`，不自绘                        |
| `search-ai-cute-re`      | `i-focal-search-ai`      | `apps/desktop/layer/renderer/src/modules/entry-content/components/EntryPlaceholderLogo.tsx`                                                                                                            | Lucide `search`，不自绘                            |
| `translate-2-ai-cute-re` | `i-focal-translate-2-ai` | `apps/desktop/layer/renderer/src/modules/command/commands/entry.tsx`；`apps/desktop/layer/renderer/src/modules/entry-column/translation.tsx`；`packages/internal/store/src/modules/action/constant.ts` | Lucide `languages`，不自绘                         |
| `rada-cute-re`           | `i-focal-rada`           | `apps/desktop/layer/renderer/src/pages/settings/(settings)/list.tsx`                                                                                                                                   | Lucide `radar`                                     |
| `line-cute-re`           | `i-focal-line`           | `packages/internal/components/src/ui/kbd/Kbd.tsx`；`apps/desktop/layer/renderer/src/modules/entry-content/components/entry-header/internal/EntryHeaderMeta.tsx`                                        | Lucide `minus`，装饰性短线                         |
| `paddle-cute-re`         | `i-focal-paddle`         | `apps/desktop/layer/renderer/src/modules/settings/tabs/ai/byok/constants.ts`，Baidu Qianfan provider                                                                                                   | 暂用 Lucide `chart-line`；千帆专属品牌仍需官方 SVG |
| `stairs-cute-re`         | `i-focal-stepfun`        | `apps/desktop/layer/renderer/src/modules/settings/tabs/ai/byok/constants.ts`，StepFun provider                                                                                                         | Lobe Icons `stepfun`                               |
| `moonshotai-original`    | `i-focal-moonshot`       | `apps/desktop/layer/renderer/src/modules/settings/tabs/ai/byok/constants.ts`；`apps/desktop/layer/renderer/src/modules/ai-chat/components/layouts/AIModelIndicator.tsx`                                | Lobe Icons `moonshot`                              |

## 品牌图标

| Focal 类名                                                                                | 来源                        | 位置                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `i-focal-openai` / `i-focal-anthropic` / `i-focal-gemini` / `i-focal-deepseek` 等 AI 品牌 | `@lobehub/icons-static-svg` | `apps/desktop/layer/renderer/src/modules/settings/tabs/ai/byok/constants.ts`；`apps/desktop/layer/renderer/src/modules/ai-chat/components/layouts/AIModelIndicator.tsx` |
| `i-focal-google`                                                                          | `logos:google-icon`         | Google 通用品牌场景；Gemini provider 不使用它                                                                                                                           |
| `i-focal-github`                                                                          | `simple-icons:github`       | `packages/internal/constants/src/auth-providers.ts`；`packages/internal/constants/src/social.ts`；`packages/internal/utils/src/link-parser.ts`                          |
| `i-focal-apple`                                                                           | `simple-icons:apple`        | `packages/internal/constants/src/auth-providers.ts`                                                                                                                     |
| `i-focal-telegram`                                                                        | `simple-icons:telegram`     | social/provider icon usages                                                                                                                                             |
| `i-focal-youtube`                                                                         | `simple-icons:youtube`      | media/provider icon usages                                                                                                                                              |
| `i-focal-social-x` / `i-focal-twitter`                                                    | `simple-icons:x`            | `packages/internal/utils/src/link-parser.ts`                                                                                                                            |

## 需要官方/自有资产的清单

这些不是 Lucide 能解决的问题。继续用通用图标会影响用户识别，手绘又有品牌风险。

| 资产                   | 当前位置                                                                     | 当前处理                                    | 后续需要                                              |
| ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| Baidu Qianfan 品牌图标 | `apps/desktop/layer/renderer/src/modules/settings/tabs/ai/byok/constants.ts` | 暂用 Lucide `chart-line` / `i-focal-paddle` | 如果要展示千帆专属品牌，需要官方可分发 SVG            |
| Focal Power token      | `apps/desktop/layer/renderer/src/modules/wallet/balance.tsx`                 | 使用 Focal 自有 SVG：`i-focal-power`        | 若 Power 是正式经济系统，需要设计规范稿和 raster 导出 |

## 维护规则

- 新增通用图标时，优先在 `scripts/update-icon.ts` 中映射到 Lucide，并通过 `i-focal-*` 使用。
- 新增状态图标时，使用 Lucide stroke + 背景/容器状态，不新增 filled icon 依赖。
- 新增 AI/LLM 品牌图标时，优先来自 `@lobehub/icons-static-svg`；新增通用品牌图标时，来自 `simple-icons`、`logos` 或官方可分发 SVG，并在本文档记录来源。
- 不允许重新创建 `icons/mgc`，不允许新增 `i-mgc-*`、`i-mingcute-*`、`i-ph-*`、`*-cute-*` 命名。
