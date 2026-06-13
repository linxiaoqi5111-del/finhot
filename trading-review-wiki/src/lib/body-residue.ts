import { parse as parseYaml } from "yaml"

export interface ResidueStripResult {
  cleanedBody: string
  certain: boolean
  reason: string
  strippedText: string
  rescued: { sources: string[]; tags: string[]; aliases: string[] }
}

const SCAN_WINDOW = 20
const MIN_FIELD_LINES = 3
const MIN_CLEANED_LENGTH = 50

const FIELD_LINE_REGEX = /^[\w一-龥][\w一-龥_-]*:\s*(\S|$)/
const LIST_ITEM_REGEX = /^\s+-\s+\S/
const HEADING_REGEX = /^#{1,6}\s+\S/
const BLANK_REGEX = /^\s*$/

function isStartLine(line: string, nextLine: string | undefined): { kind: "dash" | "asterisk" | "fence-dash" } | null {
  if (/^---\s*$/.test(line)) return { kind: "dash" }
  if (/^\*\*\*\s*$/.test(line)) return { kind: "asterisk" }
  if (/^```\s*$/.test(line) && nextLine !== undefined && /^---\s*$/.test(nextLine)) {
    return { kind: "fence-dash" }
  }
  return null
}

function isEndLine(line: string): boolean {
  return /^---\s*$/.test(line) || /^```\s*$/.test(line)
}

/** 从 body 头部识别并剖除老 frontmatter 残骸；从严，宁可漏不可错。 */
export function stripLegacyBodyResidue(body: string): ResidueStripResult {
  const empty: ResidueStripResult = {
    cleanedBody: body,
    certain: false,
    reason: "no-residue-detected",
    strippedText: "",
    rescued: { sources: [], tags: [], aliases: [] },
  }

  const lines = body.split(/\r?\n/)
  if (lines.length < MIN_FIELD_LINES + 2) return empty

  // 跳过 body 开头连续空行
  let scanStart = 0
  while (scanStart < lines.length && BLANK_REGEX.test(lines[scanStart])) scanStart++
  if (scanStart >= lines.length) return empty
  if (scanStart > SCAN_WINDOW) return empty

  // 起点检测
  const start = isStartLine(lines[scanStart], lines[scanStart + 1])
  if (!start) return empty

  const fieldsStartIdx = start.kind === "fence-dash" ? scanStart + 2 : scanStart + 1
  if (fieldsStartIdx >= lines.length) return empty

  // 内容 + 终点检测
  let endIdx = -1
  let consecutiveFieldLines = 0
  let totalFieldLines = 0
  let containsHeading = false

  for (let i = fieldsStartIdx; i < Math.min(lines.length, scanStart + SCAN_WINDOW + 30); i++) {
    const ln = lines[i]
    if (isEndLine(ln)) {
      endIdx = i
      break
    }
    if (HEADING_REGEX.test(ln)) {
      containsHeading = true
      // 标题出现 → 立即终止（残骸不会含 markdown 标题）
      break
    }
    if (BLANK_REGEX.test(ln)) {
      // 空行：如果下一行不是字段或 list 项，视为残骸结束
      const next = lines[i + 1]
      if (next === undefined || (!FIELD_LINE_REGEX.test(next) && !LIST_ITEM_REGEX.test(next))) {
        endIdx = i
        break
      }
      // 否则视为字段间空行，继续
      continue
    }
    if (FIELD_LINE_REGEX.test(ln)) {
      consecutiveFieldLines++
      totalFieldLines++
    } else if (LIST_ITEM_REGEX.test(ln)) {
      // list 项归到 totalFieldLines（不打断 consecutive）
      totalFieldLines++
    } else {
      // 既非字段也非 list 项也非分隔符 → 不像残骸，放弃
      break
    }
  }

  if (containsHeading) {
    return { ...empty, reason: "contains-heading" }
  }
  if (totalFieldLines < MIN_FIELD_LINES) {
    return { ...empty, reason: `too-few-fields (${totalFieldLines})` }
  }
  if (endIdx === -1) {
    return { ...empty, reason: "no-end-marker", certain: false, strippedText: lines.slice(scanStart, scanStart + SCAN_WINDOW).join("\n") }
  }

  // 如果起点是 fence-dash（``` + ---），吃掉对应的关闭 fence ```
  let actualEndIdx = endIdx
  if (start.kind === "fence-dash" && endIdx + 1 < lines.length && /^```\s*$/.test(lines[endIdx + 1])) {
    actualEndIdx = endIdx + 1
  }

  // 计算切除范围：[scanStart, actualEndIdx]
  // 被剖的原文（含起点和终点行）
  const strippedLines = lines.slice(scanStart, actualEndIdx + 1)
  const strippedText = strippedLines.join("\n")

  // 检查剖掉内容是否含 heading（保守再检一次）
  if (strippedLines.some((ln) => HEADING_REGEX.test(ln))) {
    return { ...empty, reason: "stripped-contains-heading" }
  }

  // 抢救字段：parse 剖掉内容里的字段块
  const fieldsBlock = lines.slice(fieldsStartIdx, endIdx).join("\n")
  const rescued = rescueListFields(fieldsBlock)

  // 重组 cleanedBody
  // 保留 scanStart 之前的空行（body 头部空行）+ actualEndIdx+1 之后的内容
  const preservedHead = lines.slice(0, scanStart)
  const tail = lines.slice(actualEndIdx + 1)
  const cleanedLines = [...preservedHead, ...tail]
  // 头部如果只剩空行，去掉
  while (cleanedLines.length > 0 && BLANK_REGEX.test(cleanedLines[0])) cleanedLines.shift()
  const cleanedBody = cleanedLines.join("\n")

  if (cleanedBody.length < MIN_CLEANED_LENGTH) {
    return {
      cleanedBody: body,
      certain: false,
      reason: `cleaned-too-short (${cleanedBody.length} < ${MIN_CLEANED_LENGTH})`,
      strippedText,
      rescued: { sources: [], tags: [], aliases: [] },
    }
  }

  return {
    cleanedBody,
    certain: true,
    reason: "ok",
    strippedText,
    rescued,
  }
}

function rescueListFields(yamlText: string): { sources: string[]; tags: string[]; aliases: string[] } {
  const empty = { sources: [] as string[], tags: [] as string[], aliases: [] as string[] }
  if (!yamlText.trim()) return empty
  let parsed: unknown
  try {
    parsed = parseYaml(yamlText)
  } catch {
    return empty
  }
  if (!parsed || typeof parsed !== "object") return empty
  const obj = parsed as Record<string, unknown>
  return {
    sources: extractStringArray(obj.sources),
    tags: extractStringArray(obj.tags),
    aliases: extractStringArray(obj.aliases),
  }
}

function extractStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim())
}

/** Set 去重的 list merge */
export function mergeListField(existing: string[] | undefined, incoming: string[]): string[] {
  const seen = new Set(existing ?? [])
  const out = [...(existing ?? [])]
  for (const x of incoming) {
    if (!seen.has(x)) {
      out.push(x)
      seen.add(x)
    }
  }
  return out
}
