# Focal 本地化清理方案

> 目标：让 Focal 成为完全独立的本地优先 RSS 阅读器，移除所有 Folo 云端依赖
>
> 创建时间：2026-06-17
> 适用版本：Focal dev 分支

## 产品定位确认

| 维度         | 状态                                   |
| ------------ | -------------------------------------- |
| 数据存储     | 完全本地（SQLite）                     |
| AI 能力      | BYOK（用户自配 OpenAI-compatible API） |
| 用户系统     | 无需登录                               |
| 云端同步     | 不需要                                 |
| 与 Folo 关系 | 仅 fork 历史遗留，运行时完全独立       |

---

## Phase 1: 类型与依赖清理（已完成 ✅）

### 任务清单

- [x] 创建本地类型定义文件 `folo-services.types.ts`
- [x] 更新 4 个文件的 import 语句（store/types.ts, AIChainOfThought.tsx, AIDisplayFlowPart.tsx, TokenUsagePill.tsx）
- [x] 从 workspace 和 package.json 移除 @folo-services/\* 直接依赖
- [x] 删除 cli-session-sync.ts 及相关调用
- [x] 同步 pnpm-lock.yaml（运行 `pnpm install --lockfile-only`）

### 重要说明

#### 1. 锁文件中的残留

**问题：** `@folo-services/*` 仍存在于 `pnpm-lock.yaml` 中。

**原因：** `@follow-app/client-sdk` 依赖这些包，因此它们是间接依赖。

**状态：** 这是预期的。要完全移除，需要替换 `@follow-app/client-sdk`（Phase 3+ 工作）。

#### 2. BizUITools 类型精度

**问题：** 最初的类型定义使用了 `[key: string]` 索引签名，破坏了 AI SDK 的 narrowing。

**解决方案：** 精确复制原包的类型定义，包括每个工具的具体 input/output 类型。

**文件：** `apps/desktop/layer/renderer/src/modules/ai-chat/types/folo-services.types.ts`

#### 3. CLI 服务的处理

**问题：** 删除 `cli-session-sync.ts` 后，`cli.ts` 服务返回 stub 值。

**当前实现：**

- `getInstallStatus` 返回空值
- `installCli` 返回错误 "CLI login sync is disabled in local RSS mode"
- `uninstallCli` 返回成功

**状态：** 这是可接受的，因为 Focal 在 LOCAL_RSS_MODE 下运行，CLI 同步本来就不应工作。

#### 4. 类型检查错误

**状态：** `@follow/web typecheck` 仍有以下错误：

- i18n 翻译键错误（与 Phase 1 无关）
- `feeds-selection-list.tsx` 中的 `output` 属性访问（与 Phase 1 无关）

**说明：** 这些错误在 Phase 1 之前已存在。

### 已修改文件

| 文件路径                                                                                    | 变更                                                                    |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/desktop/layer/renderer/src/modules/ai-chat/types/folo-services.types.ts`              | **新增** - 精确复制原包类型                                             |
| `apps/desktop/layer/renderer/src/modules/ai-chat/store/types.ts`                            | import 指向本地类型                                                     |
| `apps/desktop/layer/renderer/src/modules/ai-chat/components/displays/AIChainOfThought.tsx`  | import 指向本地类型                                                     |
| `apps/desktop/layer/renderer/src/modules/ai-chat/components/displays/AIDisplayFlowPart.tsx` | import 指向本地类型                                                     |
| `apps/desktop/layer/renderer/src/modules/ai-chat/components/message/TokenUsagePill.tsx`     | import 指向本地类型                                                     |
| `pnpm-workspace.yaml`                                                                       | 移除 @folo-services/ai-tools catalog 和 @folo-services/drizzle override |
| `packages/internal/shared/package.json`                                                     | 移除 @folo-services/drizzle 依赖                                        |
| `apps/desktop/layer/renderer/package.json`                                                  | 移除 @folo-services/ai-tools 依赖                                       |
| `apps/desktop/layer/main/src/manager/app.ts`                                                | 移除 CLI 同步代码                                                       |
| `apps/desktop/layer/main/src/ipc/services/cli.ts`                                           | 简化为 stub 实现                                                        |
| `apps/desktop/layer/main/src/ipc/services/auth.ts`                                          | 移除 CLI 同步调用                                                       |
| `apps/desktop/layer/main/src/lib/cli-session-sync.ts`                                       | **删除**                                                                |
| `pnpm-lock.yaml`                                                                            | 同步更新                                                                |

### 验证命令

```bash
# 类型检查（main 进程通过）
pnpm --filter @follow/electron-main typecheck

# 类型检查（renderer 有既有错误，但无新增 BizUITools 错误）
pnpm --filter @follow/web typecheck

# 锁文件检查（@folo-services 作为间接依赖存在）
grep "@folo-services" pnpm-lock.yaml
```

### 影响评估修正

**原表述：** "零功能影响"

**修正：**

- 功能影响：**无**（LOCAL_RSS_MODE 下原有代码不执行）
- API 行为影响：**有**（CLI IPC 服务现在返回 stub）
- 类型兼容性：**已维护**（精确复制原包类型）
- 依赖清理：**部分完成**（直接依赖已移除，间接依赖待后续处理）

---

## Phase 2: 品牌隔离（已完成 ✅）

### 任务清单

- [x] URI Scheme 替换（`folo://` → `focal://`）
- [x] Actions 剪贴板分享前缀替换（`folo:actions#` → `focal:actions#`）
- [x] JsonObfuscatedCodec 密钥替换（`Folo` → `Focal`）
- [x] Tailwind 配置清理（删除 `folo` 颜色）

### 已修改文件

| 文件路径                                                                   | 变更                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------- |
| `packages/internal/shared/src/constants.ts`                                | `APP_PROTOCOL` 改为 `focal`，保留 `folo` 作为兼容协议   |
| `apps/desktop/forge.config.cts`                                            | 注册 `focal` 协议，保留 `folo` 和 `follow` 作为兼容协议 |
| `apps/desktop/layer/renderer/src/modules/discover/DiscoverForm.tsx`        | 更新正则，支持 `focal://`                               |
| `apps/desktop/layer/renderer/src/modules/discover/UnifiedDiscoverForm.tsx` | 更新正则，支持 `focal://`                               |
| `apps/desktop/layer/renderer/src/modules/action/action-setting.tsx`        | 新分享使用 `focal:actions#`，兼容导入 `folo:actions#`   |
| `packages/internal/utils/src/json-codec.ts`                                | 编码使用 `Focal` 密钥，解码兼容 `Folo` 密钥             |
| `packages/configs/tailwindcss/web.ts`                                      | 删除 `folo` 颜色定义                                    |

### 协议兼容性矩阵

| 协议        | 用途           | 状态     |
| ----------- | -------------- | -------- |
| `focal://`  | 新链接、新分享 | 主协议   |
| `folo://`   | 兼容旧链接     | 保留兼容 |
| `follow://` | 兼容历史链接   | 保留兼容 |

### Actions 分享兼容性

| 操作         | 格式                                | 兼容性   |
| ------------ | ----------------------------------- | -------- |
| 导出（复制） | `focal:actions#`                    | 新格式   |
| 导入（粘贴） | `focal:actions#` 或 `folo:actions#` | 新旧兼容 |

### 验证结果

```bash
# Main 进程类型检查
pnpm --filter @follow/electron-main typecheck
# ✅ 通过

# Renderer 进程类型检查
pnpm --filter @follow/web typecheck
# ⚠️ 既有错误（与 Phase 2 无关）
```

---

## Phase 3: 可选优化（待实施）

### 背景说明

Focal 当前使用三套 URI Scheme：

| Scheme      | 定义位置              | 用途                   |
| ----------- | --------------------- | ---------------------- |
| `follow://` | `LEGACY_APP_PROTOCOL` | Folo 早期协议          |
| `folo://`   | `APP_PROTOCOL`        | Folo 当前协议          |
| `focal://`  | **新增**              | Focal 新协议（待实施） |

**问题：**

1. 与 Folo 应用产生协议冲突（如果用户同时安装）
2. 外部链接使用 `folo://` 而非 `focal://`
3. Actions 分享数据使用 `folo:actions#` 前缀

**解决方案：** 引入 `focal://` 作为主协议，保留 `folo://` 和 `follow://` 作为兼容协议。

### 任务 2.1: URI Scheme 替换（folo:// → focal://）

#### 什么是 URI Scheme？

URI Scheme 是操作系统用来识别应用协议的标识符。例如：

- `https://` → 浏览器
- `mailto://` → 邮件客户端
- `folo://` → Folo 应用

当用户点击 `folo://follow?url=xxx` 链接时，操作系统会启动 Folo 应用处理。

#### 为什么需要替换？

Focal 作为独立产品，应该有自己的协议标识：

- **避免冲突**：如果用户同时安装 Folo 和 Focal，`folo://` 链接可能启动错误的应用
- **品牌独立**：Focal 应该使用 `focal://` 协议
- **未来扩展**：后续可能需要协议参数来区分功能

#### 具体修改

**文件 1: `packages/internal/shared/src/constants.ts`**

```typescript
// 修改前
export const APP_PROTOCOL = DEV ? "folo-dev" : "folo"

// 修改后
export const APP_PROTOCOL = DEV ? "focal-dev" : "focal"
// 保留旧协议用于兼容读取
export const LEGACY_APP_PROTOCOL = "folo"
```

**文件 2: `apps/desktop/forge.config.cts`**

```typescript
// 修改前
protocols: [{ name: "Focal", schemes: ["folo"] }]

// 修改后
protocols: [
  { name: "Focal", schemes: ["focal"] }, // 新协议
  { name: "Focal Legacy", schemes: ["folo"] }, // 兼容旧协议
]
```

**文件 3: `apps/desktop/layer/renderer/src/modules/discover/DiscoverForm.tsx`**

```typescript
// 修改前
const isFeedLikeUrl = (value: string) => /^(?:https?:\/\/|folo:\/\/|follow:\/\/)/.test(value.trim())

// 修改后（兼容新旧）
const isFeedLikeUrl = (value: string) =>
  /^(?:https?:\/\/|focal:\/\/|folo:\/\/|follow:\/\/)/.test(value.trim())
```

**文件 4: `apps/desktop/layer/renderer/src/modules/discover/UnifiedDiscoverForm.tsx`**
同上，更新正则表达式。

#### 兼容性策略

**导出/分享（新格式）：**

- 新生成的链接使用 `focal://`
- Actions 分享使用 `focal:actions#`

**导入/读取（兼容旧格式）：**

- 继续支持读取 `folo://` 链接（6个月过渡期）
- 支持导入 `folo:actions#` 分享数据

### 任务 2.2: Actions 剪贴板分享前缀替换

#### 具体修改

**文件: `apps/desktop/layer/renderer/src/modules/action/action-setting.tsx`**

```typescript
// 修改前
const foloPrefix = "folo:actions#"

// 修改后
const focalPrefix = "focal:actions#"
const legacyFoloPrefix = "folo:actions#" // 用于兼容导入

// 导出时使用新前缀
const handleCopyToClipboard = useCallback(async () => {
  const jsonData = actionActions.exportRules()
  const codecData = JsonObfuscatedCodec.encode(jsonData)
  await copyToClipboard(`${focalPrefix}${codecData}`) // 使用 focal
}, [focalPrefix])

// 导入时兼容新旧前缀
const handleImportFromClipboard = useCallback(async () => {
  const clipboardData = await readFromClipboard()
  let codecData: string

  if (clipboardData.startsWith(focalPrefix)) {
    codecData = clipboardData.slice(focalPrefix.length)
  } else if (clipboardData.startsWith(legacyFoloPrefix)) {
    codecData = clipboardData.slice(legacyFoloPrefix.length) // 兼容旧格式
  } else {
    toast.error(t("actions.action_card.summary.invalid_clipboard"))
    return
  }

  const jsonData = JsonObfuscatedCodec.decode(codecData)
  // ...
}, [focalPrefix, legacyFoloPrefix])
```

### 任务 2.3: JsonObfuscatedCodec 密钥替换

#### 背景

`JsonObfuscatedCodec` 用于 Actions 分享数据的简单混淆编码（XOR + 自定义字符集）。

当前密钥 `"Folo"` 应该替换为 `"Focal"`。

#### 兼容性问题

**修改密钥后：**

- 新分享的数据使用 `"Focal"` 密钥编码
- 旧分享的数据使用 `"Folo"` 密钥编码

**解决方案：**

```typescript
// 解码时尝试新旧密钥
static decode(encodedStr: string): any {
  try {
    // 先尝试新密钥
    return this.decodeWithKey(encodedStr, this.newKey)
  } catch {
    // 失败后尝试旧密钥（兼容期）
    try {
      return this.decodeWithKey(encodedStr, this.legacyKey)
    } catch {
      throw new Error("Failed to decode")
    }
  }
}
```

#### 具体修改

**文件: `packages/internal/utils/src/json-codec.ts`**

```typescript
// 修改前
private static key = "Folo"

// 修改后
private static newKey = "Focal"
private static legacyKey = "Folo"

// 编码始终使用新密钥
static encode(obj: any): string {
  return this.encodeWithKey(obj, this.newKey)
}

// 解码兼容新旧密钥
static decode(encodedStr: string): any {
  try {
    return this.decodeWithKey(encodedStr, this.newKey)
  } catch {
    return this.decodeWithKey(encodedStr, this.legacyKey)
  }
}
```

### 任务 2.4: Tailwind 配置清理

#### 具体修改

**文件: `packages/configs/tailwindcss/web.ts`**

```typescript
// 删除第 51 行
// folo: "#0054FC",  ← 删除此行

// 保留第 50 行
focal: "#0054FC",
```

#### 验证

```bash
grep -r "folo" --include="*.tsx" --include="*.ts" apps/desktop/layer/renderer/src | grep -v "folo:"
# 应该无结果，确认 text-folo / bg-folo 未使用
```

---

## Phase 3: 可选优化（按需实施）

### 任务 3.1: 头像服务替换（低优先级，**可跳过**）

#### 澄清：为什么这个任务可以跳过

用户提出的疑问很中肯：Focal 不做登录，为什么需要处理头像？

**实际情况：**

- `avatar.vercel.sh/folo` 当前用于 **AI 助手头像**（AI Chat 中的机器人头像）
- 这不是用户头像，而是默认占位图

**评估：**
| 方案 | 优先级 | 说明 |
|------|--------|------|
| 保持现状 | **推荐** | vercel.sh 服务可靠，不影响功能 |
| 更换为 `focal` | 低 | 仅品牌一致性，无功能收益 |
| 本地生成 | 最低 | 增加复杂度，收益有限 |

**结论：** 此任务可跳过，不纳入后续实施计划。

### 任务 3.2: 完全移除云端同步代码分支（可选优化）

#### 背景

当前代码中保留了很多 `if (!LOCAL_RSS_MODE)` 分支，用于云端同步。例如：

```typescript
// collection/store.ts
if (LOCAL_RSS_MODE) {
  // 仅本地存储
  await collectionActions.upsertMany([collection])
} else {
  // 云端同步（Focal 不执行）
  const tx = createTransaction()
  tx.request(async () => {
    await api().collections.post({ entryId, view })
  })
}
```

#### 是否移除？

**建议：暂不移除，保持现状**

理由：

1. 这些代码在 `LOCAL_RSS_MODE = true` 时不会执行
2. 保留它们不影响功能或性能
3. 移除需要大量修改，风险较高
4. 未来如需添加可选云端同步，这些代码可复用

### 任务 3.3: 清理 App Store 链接

#### 具体修改

**文件: `packages/internal/constants/src/app.ts`**

```typescript
// 当前：指向 Folo iOS 应用
export const APP_STORE_URLS = {
  iOS: `https://apps.apple.com/us/app/folo-follow-everything/id${APPLE_APP_STORE_ID}`,
  Android: `https://play.google.com/store/apps/details?id=${GOOGLE_PLAY_PACKAGE_ID}`,
}

// 建议：删除整个常量
// Focal 目前只有 macOS 桌面端，没有移动端
```

#### 影响

需要检查是否有 UI 引用这些链接：

```bash
grep -r "APP_STORE_URLS" --include="*.tsx" --include="*.ts" apps/ packages/
```

如果有引用，相应 UI 需要处理（隐藏或修改）。

---

## 实施路线图

### 立即执行（Phase 2）

```bash
# 1. URI Scheme 替换
# 修改 constants.ts, forge.config.cts, DiscoverForm.tsx

# 2. Actions 分享前缀替换
# 修改 action-setting.tsx

# 3. JsonObfuscatedCodec 密钥替换
# 修改 json-codec.ts

# 4. Tailwind 清理
# 修改 web.ts
```

### 验证清单

- [ ] 构建成功 `pnpm run typecheck`
- [ ] 应用启动正常
- [ ] Actions 导出/导入功能正常
- [ ] RSS 订阅功能正常
- [ ] AI 功能正常

### 后续可选（Phase 3）

- [ ] 评估是否替换头像服务
- [ ] 评估是否清理 App Store 链接
- [ ] 评估是否移除云端同步代码分支（高风险，低收益）

---

## 附录：关键决策记录

| 决策                 | 选择          | 理由                                                |
| -------------------- | ------------- | --------------------------------------------------- |
| 保留 `folo://` 兼容  | ✅ 是         | 避免用户旧链接失效，与 `follow://` 共同作为兼容协议 |
| 新协议命名           | `focal://`    | 与产品名一致，作为主协议                            |
| CLI 服务处理         | 简化为 stub   | 保留 IPC 接口避免崩溃，但返回空值/错误              |
| 移除 better-auth     | ❌ 否（暂缓） | LOCAL_RSS_MODE 已隔离，移除风险高                   |
| 自建后端             | ❌ 否         | 违背本地优先原则                                    |
| 移除云端同步代码分支 | ❌ 否（暂缓） | 不影响功能，移除风险高                              |
| 头像服务替换         | ❌ 否（跳过） | 无功能影响，vercel.sh 可靠，收益低                  |
| 类型定义方式         | 精确复制      | 保持与 ai SDK 的兼容性，避免 narrowing 问题         |

---

## 变更记录

| 日期       | 版本 | 变更                                                                                   |
| ---------- | ---- | -------------------------------------------------------------------------------------- |
| 2026-06-17 | v1.0 | 初始版本，Phase 1 实施完成                                                             |
| 2026-06-17 | v1.1 | 根据反馈修正：更新类型定义精度、锁文件同步、影响评估修正、协议基线说明                 |
| 2026-06-17 | v1.2 | Phase 2 实施完成：URI Scheme 替换、Actions 分享前缀替换、Codec 密钥替换、Tailwind 清理 |
