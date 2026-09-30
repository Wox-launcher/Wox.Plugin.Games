import path from "path"
import { primaryExe } from "../files"
import { createGame } from "../game"
import { pngFromIco } from "../ico"
import { leafKey, parseRegTree, RegEntry } from "../registry"
import { emptyScan, GameLauncher, InstalledGame, ScanDeps, ScanReport } from "../types"

const INSTALL_KEYS = ["HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs", "HKLM\\SOFTWARE\\Ubisoft\\Launcher\\Installs"]
const LAUNCHER_KEYS = ["HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher", "HKLM\\SOFTWARE\\Ubisoft\\Launcher"]

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

/** Maps an install id to the icon file named in Ubisoft's configuration cache. */
export function ubisoftIconsFromConfigurations(text: string): Map<string, string> {
  const icons = new Map<string, string>()
  for (const chunk of String(text || "").split(/version:\s*2\.0/)) {
    const ids = new Set<string>()
    for (const match of chunk.matchAll(/Installs\\(\d+)\\InstallDir/g)) ids.add(match[1])
    if (ids.size !== 1) continue
    const icon = /icon_image:\s*["']?([^"'\s]+\.(?:ico|png|jpe?g))/i.exec(chunk)
    const id = ids.values().next().value
    if (!icon || !id) continue
    icons.set(id, path.win32.basename(icon[1]))
  }
  return icons
}

function configurationsFile(deps: ScanDeps): string {
  const roaming = String(deps.appData || "")
  const local = /[\\/]Roaming$/i.test(roaming) ? path.win32.join(path.win32.dirname(roaming), "Local") : path.win32.join(deps.homedir, "AppData", "Local")
  return path.win32.join(local, "Ubisoft Game Launcher", "cache", "configuration", "configurations")
}

async function readUbisoftIcons(deps: ScanDeps): Promise<Map<string, string>> {
  try {
    return ubisoftIconsFromConfigurations(await deps.readFile(configurationsFile(deps)))
  } catch {
    return new Map()
  }
}

async function launcherDataDir(deps: ScanDeps): Promise<string> {
  for (const key of LAUNCHER_KEYS) {
    const dir = String((await deps.regQuery(key, "InstallDir")) || "").trim()
    if (dir) return path.win32.join(dir, "data")
  }
  return ""
}

async function resolvedIcon(deps: ScanDeps, filePath: string): Promise<{ iconPath: string; iconType: string } | null> {
  if (!(await deps.exists(filePath))) return null
  if (!/\.ico$/i.test(filePath)) return { iconPath: filePath, iconType: "absolute" }
  // ExtractIconEx cannot read a 24-bit ico, so write a png into the plugin cache and give Wox that path.
  if (!deps.cacheDir || typeof deps.readBinary !== "function" || typeof deps.writeBinary !== "function") return null
  try {
    const png = pngFromIco(await deps.readBinary(filePath))
    if (!png) return null
    const out = path.win32.join(deps.cacheDir, "icons", path.win32.basename(filePath).replace(/\.ico$/i, ".png"))
    await deps.writeBinary(out, png)
    return { iconPath: out, iconType: "absolute" }
  } catch {
    return null
  }
}

export class UbisoftLauncher implements GameLauncher {
  readonly id = "ubisoft"
  readonly label = "Ubisoft Connect"

  async scan(deps: ScanDeps) {
    if (deps.platform !== "win32" || typeof deps.regQueryTree !== "function") return emptyScan()
    const trees = await Promise.all(INSTALL_KEYS.map(key => deps.regQueryTree(key)))
    const games: InstalledGame[] = []
    const seen = new Set<string>()
    for (const output of trees) {
      for (const game of ubisoftGamesFromReg(parseRegTree(output), deps.report)) {
        if (seen.has(game.id)) {
          void deps.report?.("candidate_skipped", { id: game.id, reason: "duplicate_game_id" })
          continue
        }
        seen.add(game.id)
        games.push(game)
      }
    }
    // The install folder often has no executable. The shortcut icon is a file under the launcher data directory.
    const icons = games.length ? await readUbisoftIcons(deps) : new Map<string, string>()
    const dataDir = icons.size ? await launcherDataDir(deps) : ""
    for (const game of games) {
      const fileName = icons.get(game.appid) || ""
      const cached = fileName && dataDir ? path.win32.join(dataDir, fileName) : ""
      const resolved = cached ? await resolvedIcon(deps, cached) : null
      if (resolved) {
        game.iconPath = resolved.iconPath
        game.iconType = resolved.iconType
        continue
      }
      game.iconPath = await primaryExe(deps, game.installDir)
      game.iconType = game.iconPath ? "fileicon" : ""
    }
    return { games, watchDirs: [] }
  }
}
