/**
 * Admission scoring for hotword terms.
 *
 * Each candidate term receives a weighted score based on:
 *   - concept match  (+5)  — term appears in knowledge-base concepts
 *   - entity match   (+4)  — term matches a known company / stock entity
 *   - sector match   (+3)  — term matches an industry sector name
 *   - dictionary hit  (+2)  — term is in the built-in FINANCE_DICTIONARY
 *   - burst bonus    (+burstScore capped at 5)
 *
 * Terms on the blacklist are always rejected (score = -1).
 * Terms on the whitelist always pass (bypass threshold).
 *
 * The registry is loaded once from the bundled JSON; blacklist / whitelist
 * are mutable at runtime so the UI can add / remove entries.
 */

import conceptRegistry from "./concept-registry.json"
import type { TermFrequency } from "./hotword-engine"

// ---------------------------------------------------------------------------
// Registry sets (built once from the static JSON)
// ---------------------------------------------------------------------------

const conceptSet = new Set<string>(conceptRegistry.concepts)
const entitySet = new Set<string>(conceptRegistry.entities)
const sectorSet = new Set<string>(conceptRegistry.sectors)

// ---------------------------------------------------------------------------
// Mutable filter lists (runtime, persisted via localStorage in the renderer)
// ---------------------------------------------------------------------------

let blacklist = new Set<string>()
let whitelist = new Set<string>()

/** Replace the entire blacklist. */
export function setBlacklist(terms: string[]): void {
  blacklist = new Set(terms)
}

/** Replace the entire whitelist. */
export function setWhitelist(terms: string[]): void {
  whitelist = new Set(terms)
}

export function getBlacklist(): string[] {
  return [...blacklist]
}

export function getWhitelist(): string[] {
  return [...whitelist]
}

export function addToBlacklist(term: string): void {
  blacklist.add(term)
  whitelist.delete(term)
}

export function removeFromBlacklist(term: string): void {
  blacklist.delete(term)
}

export function addToWhitelist(term: string): void {
  whitelist.add(term)
  blacklist.delete(term)
}

export function removeFromWhitelist(term: string): void {
  whitelist.delete(term)
}

// ---------------------------------------------------------------------------
// Scoring weights
// ---------------------------------------------------------------------------

const WEIGHT_CONCEPT = 5
const WEIGHT_ENTITY = 4
const WEIGHT_SECTOR = 3
const WEIGHT_DICTIONARY = 2
const BURST_CAP = 5

/** Default minimum score to be admitted into the snapshot. */
export const DEFAULT_ADMISSION_THRESHOLD = 2

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

export interface AdmissionDetail {
  conceptMatch: boolean
  entityMatch: boolean
  sectorMatch: boolean
  dictionaryMatch: boolean
  burstBonus: number
  rawScore: number
  admitted: boolean
}

/**
 * Check whether `term` is a substring-match in any registry set.
 * For short CJK terms (2-3 chars) we require an exact hit;
 * for longer terms we also accept the registry entry being a substring
 * of the term or vice-versa (e.g. "CPO" matching "共封装光学CPO)").
 */
function matchesSet(term: string, registry: Set<string>): boolean {
  if (registry.has(term)) return true

  // Fuzzy substring match for longer terms
  if (term.length >= 3) {
    for (const entry of registry) {
      if (entry.length >= 3 && (entry.includes(term) || term.includes(entry))) {
        return true
      }
    }
  }
  return false
}

/**
 * Compute the admission score for a single term.
 */
export function scoreTerm(
  term: string,
  burstScore: number,
  isDictionaryMatch: boolean,
  threshold = DEFAULT_ADMISSION_THRESHOLD,
): AdmissionDetail {
  if (blacklist.has(term)) {
    return {
      conceptMatch: false,
      entityMatch: false,
      sectorMatch: false,
      dictionaryMatch: false,
      burstBonus: 0,
      rawScore: -1,
      admitted: false,
    }
  }

  const conceptMatch = matchesSet(term, conceptSet)
  const entityMatch = matchesSet(term, entitySet)
  const sectorMatch = matchesSet(term, sectorSet)
  const dictionaryMatch = isDictionaryMatch

  let score = 0
  if (conceptMatch) score += WEIGHT_CONCEPT
  if (entityMatch) score += WEIGHT_ENTITY
  if (sectorMatch) score += WEIGHT_SECTOR
  if (dictionaryMatch) score += WEIGHT_DICTIONARY

  const burstBonus = Math.min(burstScore, BURST_CAP)
  score += burstBonus

  const admitted = whitelist.has(term) || score >= threshold

  return {
    conceptMatch,
    entityMatch,
    sectorMatch,
    dictionaryMatch,
    burstBonus,
    rawScore: score,
    admitted,
  }
}

/**
 * Filter an array of TermFrequency through the admission gate.
 * Returns only terms that pass; each returned term has its
 * admissionScore attached.
 */
export function filterByAdmission(
  terms: TermFrequency[],
  dictionaryMatchedTerms: Set<string>,
  threshold = DEFAULT_ADMISSION_THRESHOLD,
): (TermFrequency & { admissionScore: number })[] {
  const result: (TermFrequency & { admissionScore: number })[] = []

  for (const tf of terms) {
    const detail = scoreTerm(tf.term, tf.burstScore, dictionaryMatchedTerms.has(tf.term), threshold)
    if (detail.admitted) {
      result.push({ ...tf, admissionScore: detail.rawScore })
    }
  }

  // Sort: highest admission score first, then burst, then count
  result.sort((a, b) => {
    if (a.admissionScore !== b.admissionScore) return b.admissionScore - a.admissionScore
    if (a.isBurst !== b.isBurst) return a.isBurst ? -1 : 1
    return b.count - a.count
  })

  return result
}

// ---------------------------------------------------------------------------
// Registry stats (useful for debugging / UI display)
// ---------------------------------------------------------------------------

export function getRegistryStats(): {
  concepts: number
  entities: number
  sectors: number
  blacklist: number
  whitelist: number
} {
  return {
    concepts: conceptSet.size,
    entities: entitySet.size,
    sectors: sectorSet.size,
    blacklist: blacklist.size,
    whitelist: whitelist.size,
  }
}
