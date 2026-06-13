import { readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

export interface IndexEntryInput {
  path: string
  title?: string
  summary?: string
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

export function localDateString(date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function dailyLogPath(date = new Date()): string {
  return `wiki/logs/log-${localDateString(date)}.md`
}

export async function appendDailyLog(projectPath: string, entry: string, date = new Date()): Promise<string> {
  const pp = normalizePath(projectPath)
  const relativePath = dailyLogPath(date)
  const fullPath = `${pp}/${relativePath}`
  const existing = await readFile(fullPath).catch(() => "")
  const cleanEntry = entry.trim()
  const next = existing.trim()
    ? `${existing.replace(/\s*$/, "")}\n\n${cleanEntry}\n`
    : `# Wiki Log ${localDateString(date)}\n\n${cleanEntry}\n`
  await writeFile(fullPath, next)
  return relativePath
}

function wikiStem(relativePath: string): string {
  return relativePath.replace(/^wiki\//, "").replace(/\.md$/i, "")
}

function sectionName(relativePath: string): string {
  const match = relativePath.match(/^wiki\/([^/]+)\//)
  return match?.[1] ?? "other"
}

function hasIndexLink(indexContent: string, stem: string): boolean {
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`\\[\\[${escaped}(?:\\||\\]\\])`).test(indexContent)
}

function indexEntryFor(input: IndexEntryInput): string {
  const stem = wikiStem(input.path)
  const title = input.title?.trim()
  const label = title && title !== stem.split("/").pop() ? `|${title}` : ""
  const summary = input.summary?.trim()
  return `- [[${stem}${label}]]${summary ? ` - ${summary}` : ""}`
}

export function mergeIndexEntries(indexContent: string, entries: IndexEntryInput[]): string {
  let next = indexContent.trim() ? indexContent.replace(/\s*$/, "") : "# Wiki Index"
  const additionsBySection = new Map<string, string[]>()

  for (const entry of entries) {
    if (!entry.path.startsWith("wiki/") || !entry.path.endsWith(".md")) continue
    if (["wiki/index.md", "wiki/overview.md", "wiki/log.md"].includes(entry.path)) continue
    if (/^wiki\/logs\/log-\d{4}-\d{2}-\d{2}\.md$/.test(entry.path)) continue

    const stem = wikiStem(entry.path)
    if (hasIndexLink(next, stem)) continue
    const section = sectionName(entry.path)
    const line = indexEntryFor(entry)
    if (!additionsBySection.has(section)) additionsBySection.set(section, [])
    additionsBySection.get(section)!.push(line)
  }

  for (const [section, lines] of additionsBySection.entries()) {
    if (lines.length === 0) continue
    const header = `## ${section}`
    const headerRegex = new RegExp(`(^|\\n)${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`)
    const match = headerRegex.exec(next)
    if (match) {
      const insertAt = match.index + match[0].length
      next = `${next.slice(0, insertAt)}${lines.join("\n")}\n${next.slice(insertAt)}`
    } else {
      next = `${next}\n\n${header}\n${lines.join("\n")}`
    }
  }

  return `${next.replace(/\s*$/, "")}\n`
}
