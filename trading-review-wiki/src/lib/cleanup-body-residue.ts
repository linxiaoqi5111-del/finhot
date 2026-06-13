import { invoke } from "@tauri-apps/api/core"
import { readFile, writeFile } from "@/commands/fs"
import { parseFrontmatter, serializeFrontmatter, type WikiFrontmatter } from "@/lib/schema"
import { stripLegacyBodyResidue, mergeListField } from "@/lib/body-residue"

interface BackupResult {
  backup_path: string
  files: string[]
  backed_up: number
}

export interface UncertainItem {
  path: string
  reason: string
  preview: string
}

export interface ResidueReport {
  backup_path: string
  total: number
  cleaned: number
  aliases_rescued: number
  tags_rescued: number
  sources_rescued: number
  uncertain: UncertainItem[]
  errors: { path: string; reason: string }[]
}

export interface ResidueProgress {
  current: number
  total: number
  path: string
}

const PREVIEW_LINES = 10

function bodyPreview(body: string): string {
  return body.split(/\r?\n/).slice(0, PREVIEW_LINES).join("\n")
}

export async function cleanupBodyResidue(
  projectPath: string,
  onProgress?: (p: ResidueProgress) => void,
): Promise<ResidueReport> {
  const backup = await invoke<BackupResult>("body_residue_backup", { projectPath })

  const report: ResidueReport = {
    backup_path: backup.backup_path,
    total: backup.files.length,
    cleaned: 0,
    aliases_rescued: 0,
    tags_rescued: 0,
    sources_rescued: 0,
    uncertain: [],
    errors: [],
  }

  for (let i = 0; i < backup.files.length; i++) {
    const rel = backup.files[i]
    onProgress?.({ current: i + 1, total: backup.files.length, path: rel })

    try {
      const fullPath = `${projectPath}/${rel}`
      const raw = await readFile(fullPath)
      const { fm, body } = parseFrontmatter(raw)

      const result = stripLegacyBodyResidue(body)

      if (!result.certain) {
        // 仅在 detect 到东西（reason 不是 no-residue-detected）时报告
        if (result.reason !== "no-residue-detected") {
          report.uncertain.push({
            path: rel,
            reason: result.reason,
            preview: bodyPreview(body),
          })
        }
        continue
      }

      // 抢救字段 merge 到 fm
      const nextFm: WikiFrontmatter = { ...(fm as WikiFrontmatter) }
      let rescuedSomething = false
      if (result.rescued.sources.length > 0) {
        const merged = mergeListField(nextFm.sources, result.rescued.sources)
        if (merged.length > (nextFm.sources?.length ?? 0)) {
          report.sources_rescued += merged.length - (nextFm.sources?.length ?? 0)
          nextFm.sources = merged
          rescuedSomething = true
        }
      }
      if (result.rescued.tags.length > 0) {
        const merged = mergeListField(nextFm.tags, result.rescued.tags)
        if (merged.length > (nextFm.tags?.length ?? 0)) {
          report.tags_rescued += merged.length - (nextFm.tags?.length ?? 0)
          nextFm.tags = merged
          rescuedSomething = true
        }
      }
      if (result.rescued.aliases.length > 0) {
        const merged = mergeListField(nextFm.aliases, result.rescued.aliases)
        if (merged.length > (nextFm.aliases?.length ?? 0)) {
          report.aliases_rescued += merged.length - (nextFm.aliases?.length ?? 0)
          nextFm.aliases = merged
          rescuedSomething = true
        }
      }

      const serialized = serializeFrontmatter(nextFm, result.cleanedBody)
      await writeFile(fullPath, serialized)
      report.cleaned++
      void rescuedSomething
    } catch (err) {
      report.errors.push({ path: rel, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  return report
}
