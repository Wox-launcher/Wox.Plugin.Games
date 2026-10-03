import path from "path"
import { createGame } from "../game"
import { dedupePaths } from "../paths"
import { GameLauncher, InstalledGame, ScanDeps, ScanReport } from "../types"

export type VdfValue = string | VdfObject
export interface VdfObject {
  [key: string]: VdfValue
}

/** Splits a text KeyValues document into strings and braces. */
export function tokenizeVdf(text: string): string[] {
  const tokens: string[] = []
  let i = text && text.charCodeAt(0) === 0xfeff ? 1 : 0
  const source = String(text || "")
  while (i < source.length) {
    const ch = source[i]
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i += 1
      continue
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1
      continue
    }
    if (ch === "{" || ch === "}") {
      tokens.push(ch)
      i += 1
      continue
    }
    if (ch === '"') {
      i += 1
      let value = ""
      while (i < source.length) {
        const current = source[i]
        if (current === "\\") {
          const next = source[i + 1] || ""
          if (next === "n") value += "\n"
          else if (next === "t") value += "\t"
          else value += next
          i += next ? 2 : 1
          continue
        }
        if (current === '"') {
          i += 1
          break
        }
        value += current
        i += 1
      }
      tokens.push(value)
      continue
    }
    const start = i
    while (i < source.length && " \t\r\n{}".indexOf(source[i]) === -1) i += 1
    tokens.push(source.slice(start, i))
  }
  return tokens
}

/** Reads libraryfolders.vdf and appmanifest files. It does not understand binary appinfo. */
export function parseVdf(text: string): VdfObject {
  const tokens = tokenizeVdf(text)
  let index = 0
  function parseObject(): VdfObject {
    const value: VdfObject = {}
    while (index < tokens.length && tokens[index] !== "}") {
      const key = tokens[index]
      index += 1
      if (key == null || key === "{" || key === "}") break
      value[key] = parseValue()
    }
    if (tokens[index] === "}") index += 1
    return value
  }
  function parseValue(): VdfValue {
    const token = tokens[index]
    index += 1
    if (token === "{") return parseObject()
    return token == null ? "" : token
  }
  if (tokens[index] === "{") {
    index += 1
    return parseObject()
  }
  const root: VdfObject = {}
  while (index < tokens.length) {
    const key = tokens[index]
    index += 1
    if (!key || key === "{" || key === "}") break
    root[key] = parseValue()
  }
  return root
}

export function vdfChild(value: VdfValue | undefined, name: string): VdfValue | undefined {
  if (!value || typeof value !== "object") return undefined
  const wanted = name.toLowerCase()
  for (const key of Object.keys(value)) {
    if (key.toLowerCase() === wanted) return value[key]
  }
  return undefined
}

/** Collects library roots from either the current object form or the older string form. */
export function libraryPaths(root: VdfObject): string[] {
  const folders = vdfChild(root, "libraryfolders") || root
  if (!folders || typeof folders !== "object") return []
  const paths: string[] = []
  for (const value of Object.values(folders)) {
    if (typeof value === "string") {
      if (/[\\/]/.test(value)) paths.push(value)
      continue
    }
    if (value && typeof value === "object") {
      const folderPath = vdfChild(value, "path")
      if (typeof folderPath === "string" && folderPath.trim()) paths.push(folderPath)
    }
  }
  return paths
}

/** Drops Steam redistributables and compatibility runtimes that are not games. */
export function isRuntimeName(name: string): boolean {
  const folded = String(name || "").toLowerCase()
  return folded.includes("proton") || folded.includes("steam linux runtime") || folded.includes("redistributable") || folded.includes("steamworks common")
}

export function steamLaunchUrl(appid: string): string {
  return `steam://rungameid/${appid}`
}

export function steamStoreUrl(appid: string): string {
  return `https://store.steampowered.com/app/${appid}`
}

/** Keeps a fully installed game. StateFlags bit 4 is Steam's fully-installed flag. */
export function gameFromManifest(root: VdfObject, libraryPath: string, steamRoot: string, report?: ScanReport): InstalledGame | null {
  const state = vdfChild(root, "appstate") || root
  if (!state || typeof state !== "object") return null
  const appid = String(vdfChild(state, "appid") || "").trim()
  const name = String(vdfChild(state, "name") || "").trim()
  const installdir = String(vdfChild(state, "installdir") || "").trim()
  const flags = Number.parseInt(String(vdfChild(state, "stateflags") || "0"), 10)
  if (!appid || !name || !Number.isFinite(flags) || (flags & 4) === 0 || isRuntimeName(name)) {
    void report?.("candidate_skipped", {
      appid,
      name,
      flags,
      libraryPath,
      reason: !appid || !name ? "missing_game_identity" : isRuntimeName(name) ? "steam_runtime" : "not_fully_installed"
    })
    return null
  }
  return createGame("steam", {
    appid,
    name,
    libraryPath,
    steamRoot,
    installDir: installdir ? path.join(libraryPath, "steamapps", "common", installdir) : "",
    launchUrl: steamLaunchUrl(appid),
    storeUrl: steamStoreUrl(appid)
  })
}

export async function steamRootCandidates(deps: ScanDeps): Promise<string[]> {
  const home = deps.homedir || ""
  const found: string[] = []
  if (deps.platform === "win32") {
    found.push(await deps.regQuery("HKCU\\Software\\Valve\\Steam", "SteamPath"))
    found.push(await deps.regQuery("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"))
    found.push("C:\\Program Files (x86)\\Steam")
  } else if (deps.platform === "darwin") {
    found.push(path.join(home, "Library", "Application Support", "Steam"))
  } else {
    found.push(path.join(home, ".steam", "steam"))
    found.push(path.join(home, ".local", "share", "Steam"))
    found.push(path.join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"))
  }
  return dedupePaths(found, deps.platform)
}

async function findSteamRoot(deps: ScanDeps): Promise<string> {
  for (const candidate of await steamRootCandidates(deps)) {
    if (await deps.exists(path.join(candidate, "steamapps"))) return candidate
  }
  return ""
}

function preferLogo(paths: string[]): string {
  return (
    paths.slice().sort((left, right) => {
      const leftName = path.basename(left).toLowerCase()
      const rightName = path.basename(right).toLowerCase()
      if (leftName === "logo.png") return -1
      if (rightName === "logo.png") return 1
      return leftName.localeCompare(rightName)
    })[0] || ""
  )
}

/** Prefer small game icons over wide library logos, supporting both Steam cache layouts. */
export async function pickIcon(steamRoot: string, appid: string, deps: ScanDeps): Promise<string> {
  const id = String(appid)
  const cacheDir = path.join(steamRoot, "appcache", "librarycache", id)
  const legacyIcon = path.join(steamRoot, "appcache", "librarycache", `${id}_icon.jpg`)
  if (await deps.exists(legacyIcon)) return legacyIcon
  let entries: string[] = []
  try {
    entries = await deps.readdir(cacheDir)
  } catch {
    // A known logo can remain readable when directory enumeration is unavailable.
  }
  // Current Steam caches name game icons by their SHA-1; other JPGs are banners or covers.
  for (const entry of entries.filter(name => /^[a-f0-9]{40}\.jpg$/i.test(name)).sort()) {
    const icon = path.join(cacheDir, entry)
    if (await deps.exists(icon)) return icon
  }
  const logo = path.join(cacheDir, "logo.png")
  if (await deps.exists(logo)) return logo
  const logos: string[] = []
  for (const entry of entries) {
    if (/^logo.*\.png$/i.test(entry)) logos.push(path.join(cacheDir, entry))
    let nested: string[] = []
    try {
      nested = await deps.readdir(path.join(cacheDir, entry))
    } catch {
      continue
    }
    for (const name of nested) {
      if (/^logo.*\.png$/i.test(name)) logos.push(path.join(cacheDir, entry, name))
    }
  }
  return preferLogo(logos)
}

export function iconFromUrlShortcut(text: string): { appid: string; iconPath: string } | null {
  const source = String(text || "").replace(/^\uFEFF/, "")
  const appid = /(?:^|\r?\n)\s*URL\s*=\s*steam:\/\/rungameid\/(\d+)/i.exec(source)
  const icon = /(?:^|\r?\n)\s*IconFile\s*=\s*(.+)/i.exec(source)
  if (!appid || !icon) return null
  let iconPath = icon[1].trim()
  if ((iconPath.startsWith('"') && iconPath.endsWith('"')) || (iconPath.startsWith("'") && iconPath.endsWith("'"))) iconPath = iconPath.slice(1, -1).trim()
  if (!iconPath) return null
  return { appid: appid[1], iconPath }
}

function shortcutDirectories(deps: ScanDeps): Array<{ dir: string; maxDepth: number }> {
  if (deps.platform !== "win32") return []
  const home = deps.homedir || ""
  // Desktop shortcuts sit in the folder itself. Start menu shortcuts are nested a few levels down.
  return [
    home ? { dir: path.join(home, "Desktop"), maxDepth: 0 } : null,
    deps.publicDir ? { dir: path.join(deps.publicDir, "Desktop"), maxDepth: 0 } : null,
    deps.appData ? { dir: path.join(deps.appData, "Microsoft", "Windows", "Start Menu", "Programs"), maxDepth: 4 } : null,
    deps.programData ? { dir: path.join(deps.programData, "Microsoft", "Windows", "Start Menu", "Programs"), maxDepth: 4 } : null
  ].filter((entry): entry is { dir: string; maxDepth: number } => !!entry)
}

/** Maps a Steam app id to the icon file used by its desktop or Start menu shortcut. */
export async function collectShortcutIcons(deps: ScanDeps): Promise<Map<string, string>> {
  const icons = new Map<string, string>()
  for (const root of shortcutDirectories(deps)) {
    await readShortcutDirectory(deps, root.dir, icons, 0, root.maxDepth)
  }
  return icons
}

async function readShortcutDirectory(deps: ScanDeps, dir: string, icons: Map<string, string>, depth: number, maxDepth: number): Promise<void> {
  if (depth > maxDepth) return
  let names: string[] = []
  try {
    names = await deps.readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const full = path.join(dir, name)
    if (name.toLowerCase().endsWith(".url")) {
      try {
        const parsed = iconFromUrlShortcut(await deps.readFile(full))
        if (!parsed || icons.has(parsed.appid)) continue
        if (!(await deps.exists(parsed.iconPath))) continue
        icons.set(parsed.appid, parsed.iconPath)
      } catch {
        continue
      }
      continue
    }
    if (path.extname(name) || depth >= maxDepth) continue
    await readShortcutDirectory(deps, full, icons, depth + 1, maxDepth)
  }
}

/** Reads libraryfolders.vdf and each library's appmanifest files. */
export async function scanSteam(deps: ScanDeps): Promise<{ steamRoot: string; libraries: string[]; games: InstalledGame[] }> {
  const steamRoot = await findSteamRoot(deps)
  if (!steamRoot) return { steamRoot: "", libraries: [], games: [] }
  let libraries = [steamRoot]
  try {
    const text = await deps.readFile(path.join(steamRoot, "steamapps", "libraryfolders.vdf"))
    libraries = dedupePaths([steamRoot, ...libraryPaths(parseVdf(text))], deps.platform)
  } catch {
    libraries = [steamRoot]
  }
  const shortcutIcons = await collectShortcutIcons(deps)
  const games: InstalledGame[] = []
  const seen = new Set<string>()
  for (const library of libraries) {
    let names: string[] = []
    try {
      names = await deps.readdir(path.join(library, "steamapps"))
    } catch {
      continue
    }
    for (const name of names) {
      if (!/^appmanifest_\d+\.acf$/i.test(name)) continue
      const manifestPath = path.join(library, "steamapps", name)
      let text = ""
      try {
        text = await deps.readFile(manifestPath)
      } catch {
        continue
      }
      const game = gameFromManifest(parseVdf(text), library, steamRoot, (event, fields) => deps.report?.(event, { ...fields, manifestPath }))
      if (!game) continue
      if (seen.has(game.id)) {
        void deps.report?.("candidate_skipped", { id: game.id, manifestPath, reason: "duplicate_game_id" })
        continue
      }
      game.discoveryPath = manifestPath
      const shortcutIcon = shortcutIcons.get(game.appid)
      if (shortcutIcon) {
        game.iconPath = shortcutIcon
        game.iconType = "fileicon"
      } else {
        game.iconPath = await pickIcon(steamRoot, game.appid, deps)
        game.iconType = game.iconPath ? "absolute" : ""
      }
      games.push(game)
      seen.add(game.id)
    }
  }
  games.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  return { steamRoot, libraries, games }
}

export class SteamLauncher implements GameLauncher {
  readonly id = "steam"
  readonly label = "Steam"

  async scan(deps: ScanDeps) {
    const found = await scanSteam(deps)
    return {
      games: found.games,
      watchDirs: (found.libraries || []).map(library => path.join(library, "steamapps"))
    }
  }
}
