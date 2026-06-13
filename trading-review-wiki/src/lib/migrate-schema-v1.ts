import { invoke } from "@tauri-apps/api/core"
import { readFile, writeFile } from "@/commands/fs"
import { lookupStockCode } from "@/commands/stock-codes"
import {
  SCHEMA_VERSION,
  WIKI_TYPES,
  cleanSources,
  inferTypeFromPath,
  normalizeTypeAlias,
  normalizeStatusAlias,
  nowLocalTimestamp,
  parseFrontmatter,
  serializeFrontmatter,
  type WikiFrontmatter,
  type WikiStatus,
} from "@/lib/schema"

// 历史 LLM 偶尔会把 title 写成 "股票/万泽股份" 这种带 wiki 目录前缀的形式，需剥掉。
function stripWikiPrefix(title: string): string {
  const trimmed = title.trim().replace(/^\[+|\]+$/g, "")
  for (const t of WIKI_TYPES) {
    if (trimmed.startsWith(`${t}/`)) return trimmed.slice(t.length + 1)
  }
  return trimmed
}

export interface BackupResult {
  backup_path: string
  files: string[]
  backed_up: number
}

export interface MigrateReport {
  backup_path: string
  total: number
  migrated: number
  skipped: number
  errors: { path: string; reason: string }[]
  stocks_without_code: string[]
}

export interface MigrateProgress {
  current: number
  total: number
  path: string
}

const TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/

function normalizeTimestamp(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback
  const trimmed = raw.trim()
  if (TIMESTAMP_REGEX.test(trimmed)) return trimmed
  if (DATE_ONLY_REGEX.test(trimmed)) return `${trimmed} 00:00:00`
  return fallback
}

function fileNameTitle(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/")
  return (segments[segments.length - 1] ?? "").replace(/\.md$/i, "")
}

function isReserved(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/")
  return (
    norm === "wiki/index.md" ||
    norm === "wiki/overview.md" ||
    norm === "wiki/log.md"
  )
}

export async function migrateWikiSchemaV1(
  projectPath: string,
  onProgress?: (p: MigrateProgress) => void,
): Promise<MigrateReport> {
  // Step 1: backup + enumerate
  const backup = await invoke<BackupResult>("migrate_wiki_backup", { projectPath })

  const report: MigrateReport = {
    backup_path: backup.backup_path,
    total: backup.files.length,
    migrated: 0,
    skipped: 0,
    errors: [],
    stocks_without_code: [],
  }

  const now = nowLocalTimestamp()

  for (let i = 0; i < backup.files.length; i++) {
    const rel = backup.files[i]
    onProgress?.({ current: i + 1, total: backup.files.length, path: rel })

    try {
      const fullPath = `${projectPath}/${rel}`
      const raw = await readFile(fullPath)

      // Reserved housekeeping pages 保留结构，但确保套上 ```yaml wrapper（Milkdown 渲染友好）
      if (isReserved(rel)) {
        const parsed = parseFrontmatter(raw)
        if (parsed.hadYamlWrapper) {
          // 已经有 wrapper，跳过
          report.skipped++
        } else {
          const fm: Record<string, unknown> = { ...parsed.fm }
          const fmKeys = Object.keys(fm)
          if (fmKeys.length === 0) {
            report.skipped++
            continue
          }
          const fmLines = fmKeys.map((k) => `${k}: ${JSON.stringify(fm[k])}`).join("\n")
          const serialized = `\`\`\`yaml\n---\n${fmLines}\n---\n\`\`\`\n${parsed.body}`
          await writeFile(fullPath, serialized)
          report.migrated++
        }
        continue
      }

      const parsed = parseFrontmatter(raw)
      const fm = parsed.fm
      const body = parsed.body

      // schema_version
      const out: Partial<WikiFrontmatter> = { schema_version: SCHEMA_VERSION }

      // title — prefer existing, else from filename; strip wiki dir prefix ("股票/xxx" → "xxx")
      const titleRaw = (typeof fm.title === "string" && fm.title.trim()) || fileNameTitle(rel)
      out.title = stripWikiPrefix(titleRaw)

      // type — normalize, else infer from path
      const typeRaw = typeof fm.type === "string" ? fm.type : ""
      out.type = normalizeTypeAlias(typeRaw) ?? inferTypeFromPath(rel)

      // summary — leave empty per D13.3
      out.summary = typeof fm.summary === "string" ? fm.summary : ""

      // aliases / tags / related / sources
      if (Array.isArray(fm.aliases)) {
        out.aliases = fm.aliases.filter((x): x is string => typeof x === "string")
      } else {
        out.aliases = []
      }
      if (Array.isArray(fm.tags)) {
        out.tags = fm.tags.filter((x): x is string => typeof x === "string")
      }
      if (Array.isArray(fm.related)) {
        out.related = fm.related
          .filter((x): x is string => typeof x === "string")
          .map((s) => (s.startsWith("[[") ? s : `[[${s.replace(/^\[+|\]+$/g, "")}]]`))
      }
      if (Array.isArray(fm.sources)) {
        out.sources = cleanSources(
          fm.sources.filter((x): x is string => typeof x === "string"),
        )
      }

      // Timestamps
      const createdFallback = normalizeTimestamp(fm.created, now)
      out.created = createdFallback
      out.updated = normalizeTimestamp(fm.updated, out.created)
      // D13.5: last_reviewed = updated 值
      out.last_reviewed = normalizeTimestamp(fm.last_reviewed, out.updated)

      // confidence — default 中
      out.confidence =
        fm.confidence === "高" || fm.confidence === "中" || fm.confidence === "低"
          ? fm.confidence
          : "中"

      // status — normalize, default 活跃
      const statusRaw = typeof fm.status === "string" ? fm.status : ""
      out.status = (normalizeStatusAlias(statusRaw) as WikiStatus | null) ?? "活跃"

      // redirect (carry over verbatim if present)
      if (typeof fm.redirect === "string") out.redirect = fm.redirect

      // Type-specific
      if (out.type === "股票") {
        try {
          const code = await lookupStockCode(projectPath, out.title)
          if (code) {
            out.code = code
          } else {
            // Leave code unset; report it
            report.stocks_without_code.push(out.title)
          }
        } catch (err) {
          report.errors.push({
            path: rel,
            reason: `股票代码查询失败: ${err instanceof Error ? err.message : String(err)}`,
          })
        }
        if (typeof fm.industry === "string") out.industry = fm.industry
        if (Array.isArray(fm.concepts)) {
          out.concepts = fm.concepts.filter((x): x is string => typeof x === "string")
        }
      }

      if (out.type === "概念") {
        if (typeof fm.parent === "string") out.parent = fm.parent
        if (fm.momentum === "热" || fm.momentum === "活跃" || fm.momentum === "降温" || fm.momentum === "已死") {
          out.momentum = fm.momentum
        }
        if (Array.isArray(fm.catalysts)) {
          out.catalysts = fm.catalysts.filter((x): x is string => typeof x === "string")
        }
      }

      // Serialize and write (serializeFrontmatter accepts full type at compile time)
      const serialized = serializeFrontmatter(out as WikiFrontmatter, body)
      await writeFile(fullPath, serialized)
      report.migrated++
    } catch (err) {
      report.errors.push({
        path: rel,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return report
}
