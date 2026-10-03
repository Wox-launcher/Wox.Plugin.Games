import path from "path"
import { applyGameIcon, materializeWindowsIcon, primaryExe } from "../files"
import { createGame } from "../game"
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

/** Maps modern install IDs or resolved legacy registry references to configuration icons. */
export function ubisoftIconsFromConfigurations(text: string, legacyIds = new Map<string, string>()): Map<string, string> {
  const icons = new Map<string, string>()
  for (const chunk of String(text || "").split(/version:\s*2\.0/)) {
    const ids = new Set<string>()
    for (const match of chunk.matchAll(/Installs\\(\d+)\\InstallDir/g)) ids.add(match[1])
    if (!ids.size) {
      for (const match of chunk.matchAll(/register:[ \t]*([^\r\n]+)/gi)) {
        const id = legacyIds.get(match[1].trim().toLowerCase())
        if (id) ids.add(id)
      }
    }
    if (ids.size !== 1) continue
    const icon = /^[ \t]*icon_image:[ \t]*(?:"([^"\r\n]+)"|'([^\r\n]+)'|([^\r\n]+))[ \t]*$/im.exec(chunk)
    const file = (icon?.[1] || icon?.[2]?.replace(/''/g, "'") || icon?.[3] || "").trim()
    const id = ids.values().next().value
    if (!/\.(ico|png|jpe?g)$/i.test(file) || !id) continue
    icons.set(id, path.win32.basename(file))
  }
  return icons
}

function configurationsFile(deps: ScanDeps): string {
  const roaming = String(deps.appData || "")
  const local = /[\\/]Roaming$/i.test(roaming) ? path.win32.join(path.win32.dirname(roaming), "Local") : path.win32.join(deps.homedir, "AppData", "Local")
  return path.win32.join(local, "Ubisoft Game Launcher", "cache", "configuration", "configurations")
}

function directoryKey(dir: string): string {
  return path.win32
    .normalize(dir)
    .replace(/[\\/]+$/, "")
    .toLowerCase()
}

async function readUbisoftIcons(deps: ScanDeps, games: InstalledGame[]): Promise<Map<string, string>> {
  let text = ""
  try {
    text = await deps.readFile(configurationsFile(deps))
  } catch {
    return new Map()
  }
  const icons = ubisoftIconsFromConfigurations(text)
  const missing = games.filter(game => !icons.has(game.appid))
  if (!missing.length) return icons
  // Older games reference Ubisoft\<game>\GameUpdate\installdir instead of Launcher\Installs\<id>.
  // Match the actual registry directory to the installed game, independent of its display name.
  const installed = new Map(missing.map(game => [directoryKey(game.installDir), game.appid]))
  const legacyIds = new Map<string, string>()
  for (const key of ["HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft", "HKLM\\SOFTWARE\\Ubisoft"]) {
    try {
      for (const entry of parseRegTree(await deps.regQueryTree(key))) {
        for (const [name, value] of Object.entries(entry.values)) {
          if (!/^(installdir|installlocation|install path)$/i.test(name) || !value) continue
          const id = installed.get(directoryKey(value))
          if (!id) continue
          const reference = `${entry.key}\\${name}`.replace(/^HKLM\\/i, "HKEY_LOCAL_MACHINE\\").toLowerCase()
          // Old 32-bit clients omit WOW6432Node in their configuration references.
          for (const alias of new Set([reference, reference.replace("\\software\\wow6432node\\", "\\software\\")])) {
            legacyIds.set(alias, legacyIds.has(alias) && legacyIds.get(alias) !== id ? "" : id)
          }
        }
      }
    } catch {
      // Missing or inaccessible legacy keys must not drop modern games.
    }
  }
  for (const [id, icon] of ubisoftIconsFromConfigurations(text, legacyIds)) icons.set(id, icon)
  return icons
}

async function launcherDataDir(deps: ScanDeps): Promise<string> {
  for (const key of LAUNCHER_KEYS) {
    const dir = String((await deps.regQuery(key, "InstallDir")) || "").trim()
    if (dir) return path.win32.join(dir, "data")
  }
  return ""
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
    const icons = games.length ? await readUbisoftIcons(deps, games) : new Map<string, string>()
    const dataDir = icons.size ? await launcherDataDir(deps) : ""
    for (const game of games) {
      const fileName = icons.get(game.appid) || ""
      const cached = fileName && dataDir ? path.win32.join(dataDir, fileName) : ""
      const resolved = cached ? await materializeWindowsIcon(deps, cached) : null
      if (resolved) {
        game.iconPath = resolved.iconPath
        game.iconType = resolved.iconType
        continue
      }
      const exe = await primaryExe(deps, game.installDir)
      await applyGameIcon(deps, game, exe)
    }
    return { games, watchDirs: [] }
  }
}
