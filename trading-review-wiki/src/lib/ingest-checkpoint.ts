import { readFile, writeFile, deleteFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

/**
 * Per-source-content checkpoint. Persists intermediate progress so that
 * after a transient failure, the next ingest attempt skips already-completed stages.
 *
 * Path: <project>/.llm-wiki/ingest-state/<sha256>.json
 * Lifecycle:
 *   - Created/updated after each successful stage
 *   - Deleted after the full ingest completes (and ingest-cache.json takes over as success marker)
 */

export interface CheckpointPlanCreate {
  path: string
  type: string
  title: string
  why?: string
}

export interface CheckpointPlanUpdate {
  path: string
  why?: string
}

export interface CheckpointPlan {
  create: CheckpointPlanCreate[]
  update: CheckpointPlanUpdate[]
}

export interface IngestCheckpoint {
  sourceFileName: string
  hash: string
  timestamp: number
  analysis?: string
  plan?: CheckpointPlan
  completedUpdates?: string[]      // wiki paths already written in stage 3
  stage4Done?: boolean
  stage4Written?: string[]         // wiki paths written in stage 4 (creates + index/overview/log)
  reviewBlocksRaw?: string         // raw LLM output containing review blocks
}

function checkpointPath(projectPath: string, hash: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-state/${hash}.json`
}

export async function loadCheckpoint(
  projectPath: string,
  hash: string,
): Promise<IngestCheckpoint | null> {
  try {
    const raw = await readFile(checkpointPath(projectPath, hash))
    return JSON.parse(raw) as IngestCheckpoint
  } catch {
    return null
  }
}

export async function saveCheckpoint(
  projectPath: string,
  hash: string,
  cp: IngestCheckpoint,
): Promise<void> {
  try {
    await writeFile(checkpointPath(projectPath, hash), JSON.stringify(cp, null, 2))
  } catch {
    // non-critical
  }
}

export async function deleteCheckpoint(projectPath: string, hash: string): Promise<void> {
  try {
    await deleteFile(checkpointPath(projectPath, hash))
  } catch {
    // non-critical
  }
}

export async function sha256Hex(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}
