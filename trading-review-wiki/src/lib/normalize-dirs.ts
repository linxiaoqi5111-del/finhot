import { invoke } from "@tauri-apps/api/core"
import { readFile, writeFile } from "@/commands/fs"
import { parseFrontmatter, serializeFrontmatter, type WikiFrontmatter, type WikiType } from "@/lib/schema"

export interface DirMerge {
  from: string
  to: string
  file_count: number
}

export interface Conflict {
  original_rel: string
  kept_rel: string
  archived_to_rel: string
  kept_updated: string
  loser_updated: string
}

export interface RootMove {
  from_rel: string
  to_rel: string
}

export interface MovedFile {
  new_rel: string
  canonical_type: string
}

export interface NormalizeReport {
  backup_path: string
  dirs_merged: DirMerge[]
  conflicts: Conflict[]
  root_files_moved: RootMove[]
  uncategorized: string[]
  dirs_removed: string[]
  wikilinks_updated_files: number
  wikilinks_updated_total: number
  moved_files: MovedFile[]
  errors: [string, string][]
}

export interface NormalizeProgress {
  phase: "type-overwrite"
  current: number
  total: number
  path: string
}

/** 调用 Rust 命令做物理移动 + wikilink 替换，再 TS 端覆写 frontmatter type */
export async function normalizeWikiDirs(
  projectPath: string,
  onProgress?: (p: NormalizeProgress) => void,
): Promise<NormalizeReport> {
  const report = await invoke<NormalizeReport>("normalize_wiki_dirs", { projectPath })

  // 后置：对每个 moved_files，覆写 frontmatter type 字段
  // type 必须与所在目录的 canonical 一致（D-T24-3 决策）
  const moves = report.moved_files
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]
    onProgress?.({ phase: "type-overwrite", current: i + 1, total: moves.length, path: m.new_rel })
    try {
      const fullPath = `${projectPath}/${m.new_rel}`
      const raw = await readFile(fullPath)
      const { fm, body } = parseFrontmatter(raw)
      if (fm.type === m.canonical_type) continue // 已是 canonical，跳过
      const next: WikiFrontmatter = { ...(fm as WikiFrontmatter), type: m.canonical_type as WikiType }
      const serialized = serializeFrontmatter(next, body)
      await writeFile(fullPath, serialized)
    } catch (err) {
      report.errors.push([m.new_rel, `type 覆写失败: ${err instanceof Error ? err.message : String(err)}`])
    }
  }

  return report
}
