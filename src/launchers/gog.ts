import path from "path"
import { applyGameIcon } from "../files"
import { createGame } from "../game"
import { leafKey, parseRegTree, RegEntry } from "../registry"
import { emptyScan, GameLauncher, InstalledGame, ScanDeps, ScanReport } from "../types"

export function gogGamesFromReg(entries: RegEntry[], report?: ScanReport): InstalledGame[] {
  const games: InstalledGame[] = []
  for (const entry of entries) {
    const appid = leafKey(entry.key)
    if (!/^\d+$/.test(appid)) continue
    const values = entry.values || {}
    if (String(values.dependsOn || "").trim()) {
      void report?.("candidate_skipped", { registryKey: entry.key, reason: "gog_dlc", dependsOn: values.dependsOn })
      continue
    }
    const name = String(values.gameName || "").trim()
    const installDir = String(values.path || "").trim()
    if (!name || !installDir) {
      void report?.("candidate_skipped", { registryKey: entry.key, name, installDir, reason: "missing_game_name_or_directory" })
      continue
    }
    const exeValue = String(values.exe || "").trim()
    const iconPath = exeValue ? (path.isAbsolute(exeValue) ? exeValue : path.join(installDir, exeValue)) : ""
    const game = createGame("gog", {
      appid,
      name,
      installDir,
      launchUrl: iconPath || `goggalaxy://launchGame/${appid}`,
      discoveryPath: entry.key,
      iconPath
    })
    if (game) games.push(game)
  }
  return games
}

export class GogLauncher implements GameLauncher {
  readonly id = "gog"
  readonly label = "GOG"

  async scan(deps: ScanDeps) {
    if (deps.platform !== "win32" || typeof deps.regQueryTree !== "function") return emptyScan()
    const trees = await Promise.all([deps.regQueryTree("HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games"), deps.regQueryTree("HKLM\\SOFTWARE\\GOG.com\\Games")])
    const games: InstalledGame[] = []
    const seen = new Set<string>()
    for (const output of trees) {
      for (const game of gogGamesFromReg(parseRegTree(output), deps.report)) {
        if (seen.has(game.id)) {
          void deps.report?.("candidate_skipped", { id: game.id, reason: "duplicate_game_id" })
          continue
        }
        seen.add(game.id)
        await applyGameIcon(deps, game)
        games.push(game)
      }
    }
    return { games, watchDirs: [] }
  }
}
