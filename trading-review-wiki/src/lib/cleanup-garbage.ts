import { invoke } from "@tauri-apps/api/core"
import { readFile, renameFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/schema"
import { detectGarbagePage } from "@/lib/garbage-detector"
import { getFileName } from "@/lib/path-utils"

interface BackupResult {
  backup_path: string
  files: string[]
  backed_up: number
}

export interface ArchivedItem {
  /** 原相对路径，如 wiki/查询/-2026-05-10.md */
  original_rel: string
  /** 归档后相对路径，如 wiki/.conflicts/garbage-查询/-2026-05-10.md */
  archived_rel: string
  /** 命中的规则（中文，给用户审） */
  reasons: string[]
}

export interface GarbageReport {
  backup_path: string
  total: number
  archived: ArchivedItem[]
  errors: { path: string; reason: string }[]
}

export interface GarbageProgress {
  current: number
  total: number
  path: string
}

export async function cleanupGarbagePages(
  projectPath: string,
  onProgress?: (p: GarbageProgress) => void,
): Promise<GarbageReport> {
  const backup = await invoke<BackupResult>("cleanup_garbage_backup", { projectPath })

  const report: GarbageReport = {
    backup_path: backup.backup_path,
    total: backup.files.length,
    archived: [],
    errors: [],
  }

  for (let i = 0; i < backup.files.length; i++) {
    const rel = backup.files[i]
    onProgress?.({ current: i + 1, total: backup.files.length, path: rel })

    try {
      const fullPath = `${projectPath}/${rel}`
      const raw = await readFile(fullPath)
      const { fm, body } = parseFrontmatter(raw)
      const filename = getFileName(rel)

      const detection = detectGarbagePage(filename, fm, body)
      if (!detection.isGarbage) continue

      // 决定归档目录
      // 源 = wiki/源文档/xxx.md → wiki/.conflicts/garbage-源文档/xxx.md
      // 源 = wiki/查询/xxx.md   → wiki/.conflicts/garbage-查询/xxx.md
      const segments = rel.split("/")
      // segments[0]=wiki, segments[1]=源文档|查询, segments[2..]=basename(+subdirs)
      const sourceDir = segments[1] ?? "其他"
      const subPath = segments.slice(2).join("/")
      const archivedRel = `wiki/.conflicts/garbage-${sourceDir}/${subPath}`
      const archivedFullPath = `${projectPath}/${archivedRel}`

      await renameFile(fullPath, archivedFullPath)
      report.archived.push({
        original_rel: rel,
        archived_rel: archivedRel,
        reasons: detection.reasons,
      })
    } catch (err) {
      report.errors.push({ path: rel, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  return report
}
