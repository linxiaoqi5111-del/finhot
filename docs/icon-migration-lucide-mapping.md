# Icon Migration Mapping — Focal Icon Set → Lucide

> 目的：记录 Focal 本地通用 UI 图标迁移到 Lucide、AI/LLM provider 图标迁移到 Lobe Icons 后的范围、缺口和维护规则。

## 当前判断

| 类别                     | 规则                                                           | 原因                                                          |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------- |
| 通用 UI 图标             | 已迁移到 Lucide，经 `icons/focal/*.svg` 继续暴露为 `i-focal-*` | Lucide 线条更轻、更圆、更接近系统感                           |
| 状态 / fill 图标         | 不做一比一迁移，需重新定义状态表达                             | Lucide 基本是 stroke 图标，没有 Phosphor 那样完整的 fill 权重 |
| 第三方品牌 / AI provider | 不迁移到 Lucide，单独走品牌图标策略                            | 厂商图标不是通用 UI 图标，不能用通用图标冒充品牌              |
| Focal 自有资产           | 不迁移到 Lucide                                                | `Focal AI`、`Power token`、app icon 属于 Focal 自有视觉       |
| 旧命名                   | 继续禁止 `icons/mgc`、`i-mgc-*`、`*-cute-*`                    | 避免重新引入 MingCute 误导                                    |

## 覆盖率

基于 `scripts/icon-legacy-names.json` 的当前清单评估：

| 类型                  | 数量   | 说明                                      |
| --------------------- | ------ | ----------------------------------------- |
| Lucide 可直接映射     | 约 220 | 大部分通用 UI 图标可直接迁移              |
| 品牌图标              | 16     | 保持 `simple-icons` / `logos` / 官方 SVG  |
| Focal 自有 / 不应迁移 | 7      | `focal-ai`、`power` 等                    |
| Lucide 缺口 / 需决策  | 约 6   | 主要是旧语义不清、fill 态或厂商图标误归类 |

---

## A. 可直接迁移到 Lucide 的通用 UI 图标

这些图标语义明确，Lucide 有直接对应，迁移风险低。

| 当前 Focal 语义                    | Lucide 建议          | 说明                      |
| ---------------------------------- | -------------------- | ------------------------- |
| `add`                              | `plus`               | 新增                      |
| `close`                            | `x`                  | 关闭                      |
| `close-circle`                     | `circle-x`           | 错误 / 移除               |
| `check`                            | `check`              | 确认                      |
| `check-circle`                     | `circle-check`       | 成功                      |
| `delete-2`                         | `trash-2`            | 删除                      |
| `edit`                             | `pencil`             | 编辑                      |
| `copy` / `copy-2`                  | `copy`               | 复制                      |
| `search` / `search-2` / `search-3` | `search`             | 搜索                      |
| `download-2`                       | `download`           | 下载                      |
| `file-upload`                      | `upload`             | 上传                      |
| `external-link`                    | `external-link`      | 外链                      |
| `link`                             | `link`               | 链接                      |
| `attachment`                       | `paperclip`          | 附件                      |
| `settings-1`                       | `settings`           | 通用设置                  |
| `settings-3`                       | `settings-2`         | 设置变体                  |
| `settings-7`                       | `sliders-horizontal` | 偏好设置 / 调节           |
| `layout-leftbar-open`              | `panel-left-open`    | 展开左栏                  |
| `layout-leftbar-close`             | `panel-left-close`   | 收起左栏                  |
| `right` / `right-small`            | `chevron-right`      | 展开箭头                  |
| `left` / `left-small`              | `chevron-left`       | 返回 / 收起               |
| `up`                               | `chevron-up`         | 向上                      |
| `book-6`                           | `book-open`          | 阅读 / 书籍               |
| `rss` / `rss-2`                    | `rss`                | RSS                       |
| `inbox`                            | `inbox`              | Inbox                     |
| `folder-open`                      | `folder-open`        | 文件夹                    |
| `docment`                          | `file-text`          | 文档                      |
| `documents`                        | `files`              | 多文档                    |
| `pic`                              | `image`              | 图片                      |
| `photo-album`                      | `images`             | 图片组                    |
| `video`                            | `video`              | 视频                      |
| `mic`                              | `mic`                | 音频 / 录音               |
| `volume`                           | `volume-2`           | 有声                      |
| `volume-mute`                      | `volume-x`           | 静音                      |
| `volume-off`                       | `volume-off`         | 无声                      |
| `play`                             | `play`               | 播放                      |
| `pause`                            | `pause`              | 暂停                      |
| `stop-circle`                      | `circle-stop`        | 停止                      |
| `time`                             | `clock`              | 时间                      |
| `notification`                     | `bell`               | 通知                      |
| `information`                      | `info`               | 信息                      |
| `warning`                          | `triangle-alert`     | 警告                      |
| `safe-alert`                       | `shield-alert`       | 安全警告                  |
| `safety-certificate`               | `shield-check`       | 认证                      |
| `bookmark`                         | `bookmark`           | 收藏                      |
| `star`                             | `star`               | 星标                      |
| `share-forward`                    | `share-2`            | 分享                      |
| `refresh-2` / `refresh-4-ai`       | `refresh-cw`         | 刷新                      |
| `translate-2` / `translate-2-ai`   | `languages`          | 翻译                      |
| `paint-brush-ai`                   | `paintbrush`         | AI 画笔语义               |
| `ai`                               | `sparkles`           | AI 通用入口               |
| `robot-2`                          | `bot`                | 机器人                    |
| `magic-2`                          | `wand-sparkles`      | 魔法 / AI 快捷方式        |
| `web`                              | `globe`              | Web                       |
| `world-2`                          | `globe` / `earth`    | 世界 / 全球，需统一选一个 |
| `webhook`                          | `webhook`            | Webhook                   |

---

## B. 状态图标 — 可迁移但需要重新定义状态表达

Lucide 没有完整 fill 权重，因此这些图标不能简单替换为同名 fill。统一规则：SVG 本身只保留 Lucide stroke，不在 `*-fill.svg` 里注入背景或实心形状；状态强度由 `ActionButton active` 背景、选中容器、badge 或按钮底色承担。收藏是例外，只保留橙色 stroke，不加 active 背景。

### B1. 建议保留强状态表达的 fill

这些图标的 fill 不是装饰，而是在告诉用户“当前状态已经发生”或“这是高优先级动作”。迁移到 Lucide 后，应使用同一个 stroke 图标配合 `text-*`、`bg-*`、选中容器、badge 或按钮底色表达。

| 当前 Focal 类名                    | 当前语义           | Lucide 方案                     | 迁移处理                                         |
| ---------------------------------- | ------------------ | ------------------------------- | ------------------------------------------------ |
| `i-focal-star-fill`                | 已收藏 / 已星标    | `star`                          | 用黄色/橙色 stroke 或选中背景表达 active         |
| `i-focal-round-fill`               | 未读 / unread only | `circle`                        | 保留圆点语义，用 stroke 色、尺寸和背景表达状态   |
| `i-focal-check-fill`               | 已选择 / 已复制    | `check`                         | 菜单、Select、复制成功态用颜色或 ItemIndicator   |
| `i-focal-check-circle-fill`        | 成功               | `circle-check`                  | 成功态靠绿色 stroke 和背景，不追求实心圆         |
| `i-focal-stop-circle-fill`         | 停止生成           | `circle-stop`                   | 高风险/中断动作放在有底色按钮里                  |
| `i-focal-send-plane-fill`          | 发送消息           | `send`                          | 发送按钮靠按钮底色承载主操作强度                 |
| `i-focal-play-fill` / `pause-fill` | 播放 / 暂停        | `play` / `pause`                | 媒体主控按钮需要保留高对比容器                   |
| `i-focal-certificate-fill`         | 已认证 / claimed   | `badge-check` 或 `shield-check` | 认证状态用品牌色或 badge 容器表达                |
| `i-focal-rocket-fill`              | 增强设置已启用     | `rocket`                        | active 态用 accent stroke 或开关状态表达         |
| `i-focal-heart-fill`               | 偏好 / 情感反馈    | `heart`                         | 若表示已喜欢，用 stroke 色；若只是装饰，降为线性 |

### B2. 不建议继续依赖 fill 的图标

这些图标目前带 `fill`，但 fill 主要是历史图标风格或视觉重量，不是功能状态。迁移时优先换成 Lucide 线性图标，状态由外层 tab、chip、按钮或列表项承担。

| 当前 Focal 类名                                                                      | 当前语义               | Lucide 方案                                        | 迁移处理                           |
| ------------------------------------------------------------------------------------ | ---------------------- | -------------------------------------------------- | ---------------------------------- |
| `i-focal-rss-fill` / `i-focal-rss-2-fill`                                            | RSS / feed source      | `rss`                                              | RSS 强调色可保留在文字或图标颜色上 |
| `i-focal-paper-fill` / `i-focal-docment-fill`                                        | 文章 / entry           | `file-text` 或 `newspaper`                         | 内容类型用 tab 颜色，不靠实心图标  |
| `i-focal-pic-fill` / `i-focal-photo-album-fill`                                      | 图片 / 相册 / 头像占位 | `image` / `images`                                 | hover 遮罩或空状态容器承担强调     |
| `i-focal-video-fill` / `i-focal-mic-fill`                                            | 视频 / 音频            | `video` / `mic`                                    | 内容类型 tab 用容器选中态表达      |
| `i-focal-bubble-fill` / `i-focal-thought-fill` / `i-focal-announcement-fill`         | 全部 / 社交 / 通知分类 | `messages-square` / `message-circle` / `megaphone` | 分类色保留，图标改线性             |
| `i-focal-inbox-fill`                                                                 | feed fallback / inbox  | `inbox`                                            | 作为 fallback 图标不需要 fill      |
| `i-focal-add-fill`                                                                   | follow CTA             | `plus`                                             | 主按钮底色已经足够表达动作         |
| `i-focal-right-fill` / `i-focal-arrow-right-circle-fill`                             | 展开箭头 / 下一步      | `chevron-right` / `circle-arrow-right`             | 折叠状态靠旋转和 opacity 表达      |
| `i-focal-thought-fill` / `i-focal-rocket-fill` 在 AI shortcut 列表中作为普通图标使用 | 快捷方式装饰图标       | `message-circle` / `rocket`                        | 若非 active 状态，统一降为线性     |

建议：Lucide 迁移时，将状态视觉从“图标 fill”迁到“stroke 颜色、背景、选中容器、opacity”。不要为了 fill 态继续混入大量 Phosphor，也不要给 Lucide SVG 人为补 `fill-current`。真正需要强状态的只有 B1；B2 应作为图标风格迁移的一部分降为线性。新增强状态图标时，应在组件层使用统一 active 背景，而不是修改 SVG。

---

## C. Lucide 缺口 / 需人工决策

这些不是简单的图标库替换问题。

| 当前 Focal 类名                    | 旧语义                 | Lucide 现状                               | 建议                                                  |
| ---------------------------------- | ---------------------- | ----------------------------------------- | ----------------------------------------------------- |
| `i-focal-stairs`                   | StepFun provider       | Lucide 无 `stairs`                        | 归入 AI provider 品牌图标，不用通用图标替代           |
| `i-focal-paddle`                   | Baidu Qianfan provider | 可用 `chart-line`，但不是品牌             | 归入 AI provider 品牌图标，优先官方/开源品牌          |
| `i-focal-finger-press`             | 手指点击               | Lucide 无完全对应                         | 用 `mouse-pointer-click` 或 `pointer`，需看实际上下文 |
| `i-focal-train-fill`               | 交通/列车语义          | 有 `train-front` / `train-track`，无 fill | 若仍使用，改 `train-front`；状态态靠颜色              |
| `i-focal-world-2` / `world-2-fill` | 全球/世界              | 无 `globe-2`                              | 统一改 `globe`，不要保留两个世界图标语义              |
| `i-focal-line`                     | 装饰短线               | 可用 `minus`                              | 如果只是分隔线，优先用 CSS border/width，不用 icon    |

---

## D. 不迁移到 Lucide 的图标

| 类型       | 图标                                                                         | 处理                                        |
| ---------- | ---------------------------------------------------------------------------- | ------------------------------------------- |
| AI 品牌    | OpenAI / Anthropic / Claude / Gemini / DeepSeek / Qwen / Moonshot / Zhipu 等 | 走 `@lobehub/icons-static-svg`              |
| 通用品牌   | GitHub / Apple / YouTube / Telegram / X 等                                   | 继续 `simple-icons` / `logos`               |
| Focal 自有 | `focal-ai`                                                                   | 继续 Focal 自有资产                         |
| Focal 自有 | `power` / `power-mono` / `power-outline`                                     | 继续 Focal 自有资产                         |
| 未覆盖品牌 | Baidu Qianfan 等                                                             | 获取官方可分发 SVG，或 fallback 到 Focal AI |

---

## AI Provider Icon Mapping

> 这部分单独处理 BYOK provider 和模型指示器。它们是厂商品牌识别，不参与 Lucide 通用 UI 迁移。
>
> 2026-06-15 验证：`@lobehub/icons-static-svg@1.91.0` 为 MIT 许可，包内已包含当前大多数 AI provider / model 品牌 SVG。实施时优先用 Lobe Icons 作为 AI/LLM 图标源；`simple-icons` / `logos` 只处理通用品牌或 Lobe 未覆盖的品牌。
>
> 注意：Lobe Icons 的代码和 SVG 包是 MIT 可再分发资产，但厂商品牌仍受各自商标规则约束。文档和实现里应写成“开源 SVG 来源”，不要写成“官方授权图标”。

### 当前覆盖问题

`apps/desktop/layer/renderer/src/modules/settings/tabs/ai/byok/constants.ts` 覆盖了 18 个 BYOK provider；`AIModelIndicator.tsx` 当前只覆盖 `openai`、`google`、`anthropic`、`deepseek`、`moonshotai`、`auto`。模型指示器的 provider 覆盖范围少于 BYOK provider。

### Provider 映射

| Provider            | 当前图标             | Lobe Icons 来源                         | 建议                                             |
| ------------------- | -------------------- | --------------------------------------- | ------------------------------------------------ |
| OpenAI              | `i-focal-openai`     | `@lobehub/icons-static-svg:openai`      | 已统一为 Lobe AI 品牌图标源                      |
| Anthropic           | `i-focal-anthropic`  | `anthropic` / `claude`                  | BYOK 用 `anthropic`，模型指示器可按模型用 Claude |
| Google Gemini       | `i-focal-gemini`     | `gemini` / `google`                     | Gemini 场景用 `gemini`，不要用 Google 通用 G     |
| DeepSeek            | `i-focal-deepseek`   | `deepseek`                              | 已迁为品牌图标                                   |
| Moonshot / Kimi     | `i-focal-moonshot`   | `moonshot`                              | 已迁为品牌图标；不再用月亮图标冒充品牌           |
| Qwen                | `i-focal-qwen`       | `qwen`                                  | 已迁为品牌图标；不再用 Alibaba Cloud 代替        |
| Zhipu AI / BigModel | `i-focal-zhipu`      | `zhipu`                                 | 已迁为品牌图标                                   |
| MiniMax             | `i-focal-minimax`    | `minimax`                               | 已迁为品牌图标                                   |
| Volcengine Ark      | `i-focal-volcengine` | `volcengine`                            | 已迁为品牌图标；不再用 ByteDance 代替            |
| Baidu Qianfan       | `i-focal-paddle`     | 未查到 `qianfan`，可临时用 `baidu` 兜底 | 准确方案仍需千帆官方 SVG；否则 fallback          |
| StepFun             | `i-focal-stepfun`    | `stepfun`                               | 已迁为品牌图标；不要作为 Lucide 缺口处理         |
| Ollama              | `i-focal-ollama`     | `ollama`                                | 已迁为品牌图标                                   |
| LM Studio           | `i-focal-lmstudio`   | `lmstudio`                              | 已迁为品牌图标                                   |
| Mistral AI          | `i-focal-mistral`    | `mistral`                               | 已迁为品牌图标；不再用风图标冒充品牌             |
| xAI                 | `i-focal-xai`        | `xai`                                   | 已迁为品牌图标                                   |
| Groq                | `i-focal-groq`       | `groq`                                  | 已迁为品牌图标；注意不要和 xAI 的 Grok 混用      |
| Vercel AI Gateway   | `i-focal-vercel`     | `vercel`                                | 已迁为 Vercel 品牌图标，不用三角通用图标         |
| OpenRouter          | `i-focal-openrouter` | `openrouter`                            | 已迁为品牌图标                                   |

### 模型指示器建议

| 当前问题                                                    | 建议                                                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `AIModelIndicator.tsx` 的 `ProviderType` 少于 BYOK provider | 抽出共享 provider icon map，BYOK 和 model indicator 共用                                           |
| `moonshotai` 与 BYOK 的 `moonshot` 命名不一致               | 统一 provider key 解析，兼容 `moonshotai` → `moonshot`                                             |
| DeepSeek / Moonshot / Qwen / Zhipu 等当前存在通用图标冒充   | 改用 Lobe Icons 品牌图标；缺失时才 fallback 到 Focal AI                                            |
| provider 品牌和通用 UI 混在 `icons/focal`                   | 品牌图标可保留 `i-focal-*` 包装，但 source 必须是 Lobe Icons / `simple-icons` / `logos` / 官方 SVG |

---

## 建议实施顺序

1. 先引入 `@lobehub/icons-static-svg` 或把所需 AI provider SVG 显式纳入生成脚本。
2. 通用 UI 图标 source 使用 Lucide。
3. 单独处理 fill 状态：用容器状态、颜色、背景替代图标 fill。
4. 保留 Focal 自有资产和不可替代品牌图标。
5. 生成预览，对比高频界面后再批量替换。
