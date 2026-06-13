import { readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

/**
 * SHA256-based ingest cache.
 * Keyed by content hash so identical content under different filenames dedups.
 * Cache file: .llm-wiki/ingest-cache.json
 */

interface CacheEntry {
  sourceFileName: string
  timestamp: number
  filesWritten: string[]
}

interface CacheData {
  entries: Record<string, CacheEntry> // keyed by content hash
}

async function sha256(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

function cachePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-cache.json`
}

async function loadCache(projectPath: string): Promise<CacheData> {
  try {
    const raw = await readFile(cachePath(projectPath))
    return JSON.parse(raw) as CacheData
  } catch {
    return { entries: {} }
  }
}

async function saveCache(projectPath: string, cache: CacheData): Promise<void> {
  try {
    await writeFile(cachePath(projectPath), JSON.stringify(cache, null, 2))
  } catch {
    // non-critical
  }
}

/**
 * Check if content with this hash has already been ingested (regardless of source filename).
 * Returns the list of previously written files if cached, or null if ingest is needed.
 */
export async function checkIngestCache(
  _projectPath: string,
  _sourceFileName: string,
  sourceContent: string,
): Promise<string[] | null> {
  const cache = await loadCache(_projectPath)
  const hash = await sha256(sourceContent)
  const entry = cache.entries[hash]
  return entry ? entry.filesWritten : null
}

/**
 * Save ingest result to cache after successful ingest.
 */
export async function saveIngestCache(
  projectPath: string,
  sourceFileName: string,
  sourceContent: string,
  filesWritten: string[],
): Promise<void> {
  const cache = await loadCache(projectPath)
  const hash = await sha256(sourceContent)
  const newEntries = { ...cache.entries }
  newEntries[hash] = {
    sourceFileName,
    timestamp: Date.now(),
    filesWritten,
  }
  await saveCache(projectPath, { entries: newEntries })
}

/**
 * Remove cache entries that reference a given source filename
 * (e.g., when the source file is deleted).
 */
export async function removeFromIngestCache(
  projectPath: string,
  sourceFileName: string,
): Promise<void> {
  const cache = await loadCache(projectPath)
  const newEntries: Record<string, CacheEntry> = {}
  for (const [hash, entry] of Object.entries(cache.entries)) {
    if (entry.sourceFileName !== sourceFileName) {
      newEntries[hash] = entry
    }
  }
  await saveCache(projectPath, { entries: newEntries })
}
