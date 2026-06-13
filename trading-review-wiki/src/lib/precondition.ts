import { listDirectory, readFile } from "@/commands/fs"
import { normalizePath, getRelativePath } from "@/lib/path-utils"
import { parseFrontmatter, SCHEMA_VERSION } from "@/lib/schema"
import type { FileNode } from "@/types/wiki"

export interface PreconditionResult {
  ok: boolean
  total: number
  non_v1_pages: string[]
}

const MAX_REPORT = 20

function flattenMd(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = []
  for (const n of nodes) {
    if (n.is_dir && n.children) out.push(...flattenMd(n.children))
    else if (!n.is_dir && n.name.endsWith(".md")) out.push(n)
  }
  return out
}

const RESERVED = new Set(["index.md", "overview.md", "log.md"])

function isExcluded(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/")
  return (
    norm.startsWith(".llm-wiki/") ||
    norm.includes("/.conflicts/") ||
    norm.startsWith(".conflicts/") ||
    norm.includes("/backups/")
  )
}

export async function verifyAllSchemaV1(projectPath: string): Promise<PreconditionResult> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  const tree = await listDirectory(wikiRoot)
  const files = flattenMd(tree)

  const nonV1: string[] = []
  let total = 0

  for (const f of files) {
    const rel = getRelativePath(f.path, wikiRoot).replace(/\\/g, "/")
    if (isExcluded(rel)) continue
    if (RESERVED.has(rel)) continue // housekeeping pages allowed any shape
    total++

    let raw: string
    try {
      raw = await readFile(f.path)
    } catch {
      nonV1.push(rel)
      continue
    }
    const { fm } = parseFrontmatter(raw)
    if (fm.schema_version !== SCHEMA_VERSION) {
      if (nonV1.length < MAX_REPORT) nonV1.push(rel)
    }
  }

  return { ok: nonV1.length === 0, total, non_v1_pages: nonV1 }
}
