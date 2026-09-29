import { GLOBAL_RESULT_LIMIT } from "./constants"
import { isGameRecord } from "./game"
import { InstalledGame } from "./types"

export interface ScoredGame {
  game: InstalledGame
  score: number
}

export function foldName(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
}

export function isSubsequence(text: string, pattern: string): boolean {
  let index = 0
  for (const ch of text) {
    if (ch === pattern[index]) index += 1
    if (index === pattern.length) return true
  }
  return false
}

export function scoreName(name: string, search: string): number {
  const foldedName = foldName(name)
  const foldedSearch = foldName(search)
  if (!foldedName || !foldedSearch) return 0
  if (foldedName === foldedSearch) return 1000
  if (foldedName.startsWith(foldedSearch)) return 800
  const at = foldedName.indexOf(foldedSearch)
  if (at >= 0) return 700 - Math.min(at, 200)
  // A single letter is a subsequence of almost every title, so global search ignores it.
  if (foldedSearch.length >= 2 && isSubsequence(foldedName, foldedSearch)) return 400
  return 0
}

export function compareName(left: string, right: string): number {
  return String(left || "").localeCompare(String(right || ""), undefined, { sensitivity: "base" })
}

export interface MatchOptions {
  global?: boolean
  limit?: number
}

/** Answers from an in-memory snapshot. Global search with an empty box returns nothing. */
export function matchGames(games: InstalledGame[], search: string, options: MatchOptions = {}): ScoredGame[] {
  const list = Array.isArray(games) ? games.filter(isGameRecord) : []
  const term = String(search || "").trim()
  const global = options.global === true
  if (global && !term) return []
  if (!term) {
    return list
      .slice()
      .sort((a, b) => compareName(a.name, b.name))
      .map(game => ({ game, score: 0 }))
  }
  const matched: ScoredGame[] = []
  for (const game of list) {
    const score = scoreName(game.name, term)
    if (score > 0) matched.push({ game, score })
  }
  matched.sort((a, b) => b.score - a.score || compareName(a.game.name, b.game.name))
  const cap = global ? (options.limit && options.limit > 0 ? options.limit : GLOBAL_RESULT_LIMIT) : 0
  return cap > 0 ? matched.slice(0, cap) : matched
}
