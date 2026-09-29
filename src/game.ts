import { FAVORITES_GROUP_SCORE, LAUNCHER_LABELS, LAUNCHER_ORDER } from "./constants"
import { GameDraft, InstalledGame } from "./types"

export function sourceLabel(id: string): string {
  return LAUNCHER_LABELS[id] || id
}

export function launcherGroupScore(source: string): number {
  const index = LAUNCHER_ORDER.indexOf(source)
  const rank = index < 0 ? LAUNCHER_ORDER.length : index
  return (LAUNCHER_ORDER.length - rank) * 10
}

export function favoritesGroupScore(): number {
  return FAVORITES_GROUP_SCORE
}

export function parseFavorites(value: string | undefined): string[] {
  try {
    const parsed = JSON.parse(value || "[]") as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map(id => String(id || "").trim()).filter(Boolean)
  } catch {
    return []
  }
}

export function createGame(source: string, fields: GameDraft): InstalledGame | null {
  const appid = String(fields.appid || "").trim()
  const name = String(fields.name || "").trim()
  const launchUrl = String(fields.launchUrl || "").trim()
  if (!appid || !name || !launchUrl) return null
  const iconPath = fields.iconPath || ""
  return {
    id: `${source}:${appid}`,
    source,
    appid,
    name,
    libraryPath: fields.libraryPath || fields.installDir || "",
    steamRoot: fields.steamRoot || "",
    installDir: fields.installDir || "",
    launchUrl,
    launchArgs: Array.isArray(fields.launchArgs) ? fields.launchArgs : [],
    offerIds: fields.offerIds || [],
    discoveryPath: fields.discoveryPath || "",
    launchError: fields.launchError || "",
    storeUrl: fields.storeUrl || "",
    iconPath,
    iconType: iconPath ? fields.iconType || "fileicon" : ""
  }
}

export function isGameRecord(game: unknown): game is InstalledGame {
  if (!game || typeof game !== "object") return false
  const record = game as Partial<InstalledGame>
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    record.name.trim() !== "" &&
    typeof record.appid === "string" &&
    record.appid.trim() !== "" &&
    typeof record.launchUrl === "string" &&
    record.launchUrl !== "" &&
    typeof record.source === "string" &&
    record.source !== ""
  )
}

/** Fill fields that older cache entries omitted so launch code can read them directly. */
export function normalizeGame(game: InstalledGame): InstalledGame {
  const iconPath = game.iconPath || ""
  return {
    ...game,
    libraryPath: game.libraryPath || game.installDir || "",
    steamRoot: game.steamRoot || "",
    installDir: game.installDir || "",
    launchArgs: Array.isArray(game.launchArgs) ? game.launchArgs : [],
    offerIds: Array.isArray(game.offerIds) ? game.offerIds : [],
    discoveryPath: game.discoveryPath || "",
    launchError: game.launchError || "",
    storeUrl: game.storeUrl || "",
    iconPath,
    iconType: iconPath ? game.iconType || "fileicon" : ""
  }
}
