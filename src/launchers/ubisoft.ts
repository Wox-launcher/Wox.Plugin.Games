import path from "path"
import { primaryExe } from "../files"
import { createGame } from "../game"
import { leafKey, parseRegTree, RegEntry } from "../registry"
import { emptyScan, GameLauncher, InstalledGame, ScanDeps, ScanReport } from "../types"

export function ubisoftGamesFromReg(entries: RegEntry[], report?: ScanReport): InstalledGame[] {
  const games: InstalledGame[] = []
  for (const entry of entries) {
    const appid = leafKey(entry.key)
    if (!/^\d+$/.test(appid)) continue
    const installDir = String((entry.values || {}).InstallDir || "").trim()
    if (!installDir) {
      void report?.("candidate_skipped", { registryKey: entry.key, reason: "missing_install_directory" })
      continue
    }
    const name = path.basename(installDir.replace(/[\\/]+$/, ""))
    const game = createGame("ubisoft", {
      appid,
      name,
      installDir,
      launchUrl: `uplay://launch/${appid}`,
      discoveryPath: entry.key
    })
    if (game) games.push(game)
  }
  return games
}

export class UbisoftLauncher implements GameLauncher {
  readonly id = "ubisoft"
  readonly label = "Ubisoft Connect"

  async scan(deps: ScanDeps) {
    if (deps.platform !== "win32" || typeof deps.regQueryTree !== "function") return emptyScan()
    const trees = await Promise.all([deps.regQueryTree("HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs"), deps.regQueryTree("HKLM\\SOFTWARE\\Ubisoft\\Launcher\\Installs")])
    const games: InstalledGame[] = []
    const seen = new Set<string>()
    for (const output of trees) {
      for (const game of ubisoftGamesFromReg(parseRegTree(output), deps.report)) {
        if (seen.has(game.id)) {
          void deps.report?.("candidate_skipped", { id: game.id, reason: "duplicate_game_id" })
          continue
        }
        if (!game.iconPath) {
          game.iconPath = await primaryExe(deps, game.installDir)
          game.iconType = game.iconPath ? "fileicon" : ""
        }
        seen.add(game.id)
        games.push(game)
      }
    }
    return { games, watchDirs: [] }
  }
}
