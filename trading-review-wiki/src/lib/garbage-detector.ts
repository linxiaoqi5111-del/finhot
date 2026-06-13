/**
 * 历史污染页扫描器 — 识别 wiki/源文档/ 和 wiki/查询/ 下的"垃圾"页。
 *
 * 设计原则：宁可多检出（archive，不删，可恢复），不放过明显垃圾。
 * 不使用 page-name-validator 因为这里检的是已写入的文件，规则维度不同（含文件名 + body）。
 */

import type { WikiFrontmatter } from "@/lib/schema"

export interface GarbageDetection {
  isGarbage: boolean
  /** 命中的具体规则（透明展示给用户）；isGarbage=false 时空数组 */
  reasons: string[]
}

// ── Title 起始模式（明显的 LLM 回复模板）──────────────────────
const GARBAGE_TITLE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // 各种「好的，X」分支 — chat LLM 回复开场白
  { pattern: /^好的[，,]?\s*(以下|这是|我|现在|让我|这边|我来|来|这就|马上|没问题|收到)/, reason: "title 以「好的，X」chat 开场白开头" },
  { pattern: /^好的[，,。]?\s*$/, reason: "title 仅「好的」" },
  // 思考过程残留
  { pattern: /^<think(?:ing)?>/i, reason: "title 是 <think> 标签" },
  // 代码块/Markdown 起手
  { pattern: /^```/, reason: "title 以 ``` 起手" },
  // Save to Wiki 自身/路径残留
  { pattern: /^Save to Wiki/i, reason: "title 是 Save to Wiki 自身回流" },
  { pattern: /^Source:\s*\S/i, reason: "title 是 Source: xxx 兜底命名（T28 之后不再产，历史一律视为垃圾）" },
  { pattern: /^queries?\//i, reason: "title 是 queries/xxx 路径残留" },
  { pattern: /^entities\//i, reason: "title 是 entities/xxx 路径残留" },
  { pattern: /^concepts?\//i, reason: "title 是 concepts/xxx 路径残留" },
  // 其它常见 LLM 模板
  { pattern: /^以下是/, reason: "title 以「以下是」开头（LLM 回复模板）" },
  { pattern: /^这份/, reason: "title 以「这份」开头（LLM 描述源文档）" },
  { pattern: /^你可以/, reason: "title 以「你可以」开头（LLM 指令）" },
]

// ── 文件名垃圾模式（slug 算法失效的产物）──────────────────────
const GARBAGE_FILENAME_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // 空 slug + 可选 -N suffix（修了原版只匹配 -2026-05-06.md 而漏 -2026-05-06-1.md 的 bug）
  { pattern: /^-\d{4}-\d{2}-\d{2}(-\d+)?\.md$/, reason: "文件名空 slug（仅日期前缀）" },
  // 单字符/单数字 + 日期（如 `2-2026-05-06.md`、`4-2026-05-04.md`）
  { pattern: /^[一-龥a-zA-Z0-9]-\d{4}-\d{2}-\d{2}(-\d+)?\.md$/, reason: "文件名是单字符+日期（slug 残废）" },
  // 「数字+md-」起手（如 `51md-wiki-sav-2026-05-05.md`）
  { pattern: /^\d+md-/, reason: "文件名以「数字+md-」起手（chat title 截断）" },
  // 极度混乱的 chat slug（多重数字日期拼接如 `20260503ai53md-wiki-2026-05-05.md`）
  { pattern: /^\d{8}/, reason: "文件名以 8 位数字日期起手（chat slug 残废）" },
  // fallback 默认名
  { pattern: /^filename\.md$/i, reason: "文件名是 filename.md（默认 fallback）" },
  // 双日期模式
  { pattern: /\d{4}-\d{2}-\d{2}.*\d{4}-\d{2}-\d{2}/, reason: "文件名含双日期模式" },
  // 常见 slug 模式："think" / "wiki" / "markdown" + 日期
  { pattern: /^think-\d{4}-\d{2}-\d{2}/, reason: "文件名以「think-日期」起手（chat <think> 残留）" },
  { pattern: /^wiki-\d{4}-\d{2}-\d{2}/, reason: "文件名以「wiki-日期」起手（Save to Wiki 残留）" },
  { pattern: /^markdown-\d{4}-\d{2}-\d{2}/, reason: "文件名以「markdown-日期」起手（slug 错误命名）" },
  { pattern: /^save-to-wiki-/, reason: "文件名以「save-to-wiki-」起手（按钮文本回流）" },
  // 双 -- 表示空字段拼接（如 `research--2026-04-22.md`、`scale-up--2026-05-10.md`）
  // slug 内部允许单个 -，但 -- 在 slug 与日期之间表示空字段
  { pattern: /^[a-zA-Z][a-zA-Z-]*[a-zA-Z]--\d{4}-\d{2}-\d{2}/, reason: "文件名含双 `--`（slug 空字段拼接）" },
  // 中文「好的」开头的文件名（如 `好的，现在写入。-2026-05-07.md`）
  { pattern: /^好的/, reason: "文件名以「好的」中文开头（chat 回复 slug）" },
  // 「这份」「以下是」「你可以」等 LLM 描述模板开头的文件名
  { pattern: /^(这份|以下是|你可以)/, reason: "文件名以 LLM 描述模板开头" },
  // 日期前缀 + 中文长串描述（如 `2026-05-09-舆情文件的关键提炼.md`）
  // 注意：合法 deep research 输出是 `research-{slug}-{date}.md`，不是日期开头
  // 所以以日期开头的中文长串大概率是 chat title 残留
  { pattern: /^\d{4}-\d{2}-\d{2}-[一-龥]{4,}/, reason: "文件名是「日期-中文长串」（chat title 残留）" },
]

/**
 * 识别一个 wiki 页面是否是垃圾历史污染。
 *
 * @param filename - 文件名（含 .md 后缀，不含路径）
 * @param fm - 已解析的 frontmatter
 * @param body - frontmatter 之后的正文（不含 fm 块）
 */
export function detectGarbagePage(
  filename: string,
  fm: Partial<WikiFrontmatter>,
  body: string,
): GarbageDetection {
  const reasons: string[] = []
  const title = String(fm.title ?? "").trim()
  const bodyTrimmed = body.trim()

  // 1) Title 起始模式
  for (const { pattern, reason } of GARBAGE_TITLE_PATTERNS) {
    if (pattern.test(title)) {
      reasons.push(reason)
      break // 一个 title 模式命中就够
    }
  }

  // 2) Title 退化值
  if (!title) reasons.push("title 为空")
  else if (title === "filename") reasons.push("title 是 filename")
  else if (title === "<think>") reasons.push("title 是 <think>")
  else if (title === "Saved Query") reasons.push("title 是默认 Saved Query")

  // 3) 文件名垃圾模式
  for (const { pattern, reason } of GARBAGE_FILENAME_PATTERNS) {
    if (pattern.test(filename)) {
      reasons.push(reason)
      break
    }
  }

  // 4) Body 过短（< 100 字符）
  if (bodyTrimmed.length < 100) {
    reasons.push(`body 过短（${bodyTrimmed.length} 字符 < 100）`)
  }

  // 5) Body 包含 <think> 推理标签 — LLM 思考过程被错误存档
  if (/<think(?:ing)?>/i.test(body)) {
    reasons.push("body 含 <think> 推理过程残留")
  }

  // 6) Body 含 [Binary file: ...] 占位（chat 把二进制文件名当内容存了）
  if (/\[Binary file:/i.test(body)) {
    reasons.push("body 含 [Binary file: ...] 占位（chat 二进制兜底）")
  }

  return {
    isGarbage: reasons.length > 0,
    reasons,
  }
}
