import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import { errorDetails } from "../errors"
import { applyGameIcon, isHelperExecutable, primaryExe } from "../files"
import { createGame } from "../game"
import { dedupePaths } from "../paths"
import { displayIconPath, leafKey, parseRegTree, RegEntry } from "../registry"
import { decodeXmlText } from "../xml"
import { emptyScan, GameLauncher, InstalledGame, ScanDeps, ScanReport } from "../types"

const EA_SKIP = /^(ea desktop|ea core|ea app|origin|eacore)$/i

/** A client that was already up is old enough for EALaunchHelper to see it. A client this plugin just started must show a window first. */
export const EA_READY_AGE_MS = 8000
export const EA_READY_TIMEOUT_MS = 60000
export const EA_READY_POLL_MS = 500

export type EaClientState = "window" | "running" | "absent"

export interface EaClientSnapshot {
  state: EaClientState
  ageMs: number
}

export interface EaLaunchDeps {
  open: (target: string, args?: string[]) => Promise<unknown>
  snapshot: () => Promise<EaClientSnapshot>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  timeoutMs?: number
  pollMs?: number
  readyAgeMs?: number
}

export function parseEaSnapshot(output: string): EaClientSnapshot {
  const lines = String(output || "")
    .replace(/\0/g, "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = /^(window|running|absent)(?:\s+(\d+))?$/i.exec(lines[index])
    if (!match) continue
    return { state: match[1].toLowerCase() as EaClientState, ageMs: Number(match[2] || 0) }
  }
  return { state: "absent", ageMs: 0 }
}

/** EALauncher.exe with no arguments. It starts EADesktop.exe -ls=Launcher through the signed-in user's Explorer token. */
export function eaLauncherExecutable(): string {
  const roots = [process.env.ProgramW6432, process.env.ProgramFiles, "C:\\Program Files"].filter((root): root is string => !!root)
  for (const root of roots) {
    const candidate = path.win32.join(root, "Electronic Arts", "EA Desktop", "EA Desktop", "EALauncher.exe")
    if (fs.existsSync(candidate)) return candidate
  }
  return ""
}

/** One sample of EADesktop.exe. The compatibility32 helper is a child of the real client and is ignored. */
export function readEaClient(): EaClientSnapshot {
  const script = [
    "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$procs = @(Get-Process -Name 'EADesktop' -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and $_.Path -notmatch '\\\\compatibility32\\\\' } catch { $false } })",
    "if ($procs.Count -eq 0) { 'absent 0'; exit 0 }",
    "$age = [int]((Get-Date) - @($procs | Sort-Object StartTime)[0].StartTime).TotalMilliseconds",
    "if (@($procs | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0) { 'window ' + $age; exit 0 }",
    "'running ' + $age"
  ].join("; ")
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 8000 })
  return parseEaSnapshot(`${result.stdout || ""}\n${result.stderr || ""}`)
}

/**
 * origin2:// with no EADesktop running makes EALaunchHelper start EADesktop.exe -updater_call.
 * That process cannot create the game (access denied, launch error 9), and Play inside that window fails until the EA cache is cleared.
 * A client started by EALauncher accepts the same URL. Start that client first, then send the protocol once its window is up.
 */
export async function launchEaGame(protocolUrl: string, launcherExe: string, deps: EaLaunchDeps): Promise<{ mode: "ready" | "deferred"; sawWindow: boolean }> {
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const now = deps.now || Date.now
  const timeoutMs = deps.timeoutMs ?? EA_READY_TIMEOUT_MS
  const pollMs = deps.pollMs ?? EA_READY_POLL_MS
  const readyAgeMs = deps.readyAgeMs ?? EA_READY_AGE_MS
  const initial = await deps.snapshot()
  if (initial.state === "window" || (initial.state === "running" && initial.ageMs >= readyAgeMs)) {
    await deps.open(protocolUrl, [])
    return { mode: "ready", sawWindow: initial.state === "window" }
  }
  const alreadyRunning = initial.state === "running"
  if (!alreadyRunning) {
    if (!launcherExe) throw new Error("EA App is not running")
    await deps.open(launcherExe, [])
  }
  const deadline = now() + timeoutMs
  let sawWindow = false
  let sawProcess = alreadyRunning
  let latest = initial
  const maxPolls = Math.ceil(timeoutMs / pollMs) + 1
  for (let poll = 0; poll < maxPolls; poll++) {
    latest = await deps.snapshot()
    if (latest.state !== "absent") sawProcess = true
    if (latest.state === "window") {
      sawWindow = true
      break
    }
    if (alreadyRunning && latest.state === "running" && latest.ageMs >= readyAgeMs) break
    if (now() >= deadline) break
    await sleep(pollMs)
  }
  // A client this plugin just started is not safe to offer origin2 until its window exists.
  // Before that, EALaunchHelper treats the client as absent and starts a second EADesktop -updater_call.
  const clientReady = sawWindow || (alreadyRunning && latest.state === "running" && latest.ageMs >= readyAgeMs)
  if (!clientReady) {
    throw new Error(sawProcess ? "EA App is still starting" : "EA App did not start")
  }
  await deps.open(protocolUrl, [])
  return { mode: "deferred", sawWindow }
}

export function eaGamesFromReg(entries: RegEntry[], report?: ScanReport): InstalledGame[] {
  const games: InstalledGame[] = []
  for (const entry of entries) {
    const leaf = leafKey(entry.key)
    if (!leaf || EA_SKIP.test(leaf)) continue
    const values = entry.values || {}
    const installDir = dedupePaths([values["Install Dir"] || values.InstallDir || values.InstallPath || values.InstallLocation || ""], "win32")[0] || ""
    if (!installDir || !path.win32.isAbsolute(installDir)) {
      void report?.("candidate_skipped", { registryKey: entry.key, reason: "missing_install_directory", valueNames: Object.keys(values) })
      continue
    }
    const name = String(values.DisplayName || leaf).trim()
    const offerId = /\\Origin Games\\/i.test(entry.key) && /^\d+$/.test(leaf) ? leaf : ""
    const game = createGame("ea", {
      appid: leaf,
      name,
      installDir,
      launchUrl: offerId ? `origin2://game/launch?offerIds=${offerId}` : installDir,
      offerIds: offerId ? [offerId] : [],
      iconPath: displayIconPath(String(values.DisplayIcon || ""))
    })
    void report?.("ea_registry_candidate", { registryKey: entry.key, name, installDir, offerId })
    if (game) games.push(game)
  }
  return games
}

export function eaGameFromInstallerXml(xml: string, installDir: string, report?: ScanReport): InstalledGame | null {
  const name = /<gameTitle[^>]*>([^<]+)<\/gameTitle>/i.exec(xml)
  const offerIds = uniqueContentIds(xml)
  const executable = launcherFilePath(xml)
  if (!name) {
    void report?.("candidate_skipped", { installDir, reason: "installer_xml_missing_game_title" }, "Warning")
    return null
  }
  // Registry tokens stay intact here. Scanning resolves them, because [INSTALLDIR] is the only prefix that can be expanded without a registry read.
  const iconPath = unresolvedRegistryExecutable(executable) ? executable : installDirExecutable(executable, installDir)
  void report?.("ea_manifest", { installDir, name: decodeXmlText(name[1]), offerIds, executable })
  return createGame("ea", {
    appid: offerIds[0] || path.basename(installDir),
    name: decodeXmlText(name[1]),
    installDir,
    // Let EA apply its launch configuration, including game-specific setup windows and arguments.
    launchUrl: offerIds.length ? `origin2://game/launch?offerIds=${offerIds.map(encodeURIComponent).join(",")}` : iconPath || installDir,
    offerIds,
    iconPath
  })
}

/** The launcher file inside <runtime>. Later <filePath> entries belong to touchup and the install manifest. */
function launcherFilePath(xml: string): string {
  const runtime = /<runtime\b[^>]*>([\s\S]*?)<\/runtime>/i.exec(xml)
  const source = runtime ? runtime[1] : xml
  const filePath = /<filePath>([^<]*)<\/filePath>/i.exec(source)
  return filePath ? decodeXmlText(filePath[1]) : ""
}

function unresolvedRegistryExecutable(filePath: string): boolean {
  return /\[(?:HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER|HKLM|HKCU)\\/i.test(filePath)
}

function installDirExecutable(filePath: string, installDir: string): string {
  const relative = filePath.replace(/^\[INSTALLDIR\][\\/]?/i, "")
  if (!relative) return ""
  return path.win32.isAbsolute(relative) ? relative : path.join(installDir, relative)
}

function collapseWinSeparators(value: string): string {
  const unc = value.startsWith("\\\\") || value.startsWith("//")
  const collapsed = value.replace(/[\\/]+/g, "\\")
  return unc && !collapsed.startsWith("\\\\") ? `\\${collapsed}` : collapsed
}

/**
 * Expand an Origin installer executable.
 * Manifests use `[INSTALLDIR]Game.exe` or `[HKEY_LOCAL_MACHINE\...\Install Dir]Game.exe`.
 * A missing registry value falls back to the install directory already discovered for this game.
 */
export async function resolveEaFilePath(raw: string, installDir: string, regQuery?: ScanDeps["regQuery"]): Promise<string> {
  let text = decodeXmlText(raw).trim()
  if (!text) return ""
  const tokens = [...text.matchAll(/\[((?:HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER|HKLM|HKCU)\\[^[\]]+)\]/gi)]
  for (const token of tokens) {
    const spec = token[1].replace(/\//g, "\\")
    const slash = spec.lastIndexOf("\\")
    let value = ""
    if (slash > 0 && regQuery) {
      try {
        value = String((await regQuery(spec.slice(0, slash), spec.slice(slash + 1))) || "")
      } catch {
        value = ""
      }
    }
    const directory = (value || installDir).replace(/[\\/]+$/, "")
    text = text.replace(token[0], () => (directory ? `${directory}\\` : ""))
  }
  text = text.replace(/\[INSTALLDIR\]/gi, () => {
    const directory = installDir.replace(/[\\/]+$/, "")
    return directory ? `${directory}\\` : ""
  })
  if (/\[[^[\]]+\]/.test(text)) return ""
  text = collapseWinSeparators(text).trim()
  if (!path.win32.isAbsolute(text)) {
    const relative = text.replace(/^[\\/]+/, "")
    if (!relative || !path.win32.isAbsolute(installDir)) return ""
    text = path.win32.join(installDir, relative)
  }
  const normalized = path.win32.normalize(text)
  return path.win32.extname(normalized) ? normalized : ""
}

async function existingExecutables(deps: ScanDeps, candidates: string[], installDir: string): Promise<string[]> {
  const found: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const resolved = await resolveEaFilePath(candidate, installDir, deps.regQuery)
    const key = resolved.toLowerCase()
    if (!resolved || seen.has(key) || !(await deps.exists(resolved))) continue
    seen.add(key)
    found.push(resolved)
  }
  return found
}

async function existingExecutable(deps: ScanDeps, candidates: string[], installDir: string): Promise<string> {
  const found = await existingExecutables(deps, candidates, installDir)
  return found[0] || primaryExe(deps, installDir)
}

/** Prefer the game executable. Anti-cheat launchers embed the generic EA logo. */
async function gameIcon(deps: ScanDeps, candidates: string[], installDir: string): Promise<string> {
  const found = await existingExecutables(deps, candidates, installDir)
  return found.find(file => !isHelperExecutable(file)) || (await primaryExe(deps, installDir)) || found[0] || ""
}

function uniqueContentIds(xml: string): string[] {
  const offerIds: string[] = []
  const matcher = /<contentID\b[^>]*>([^<]+)<\/contentID>/gi
  let found = matcher.exec(String(xml))
  while (found) {
    const value = decodeXmlText(found[1])
    if (value && !offerIds.includes(value)) offerIds.push(value)
    found = matcher.exec(String(xml))
  }
  return offerIds
}

export class EaLauncher implements GameLauncher {
  readonly id = "ea"
  readonly label = "EA"

  async scan(deps: ScanDeps) {
    if (deps.platform !== "win32") return emptyScan()
    const games = new Map<string, InstalledGame>()
    const watchDirs: string[] = []
    // Resolve each directory once. Registry and directory scans often describe the same installation.
    const addDirectory = async (dir: string, fallback?: InstalledGame | null) => {
      const installDir = dedupePaths([dir], "win32")[0] || ""
      const key = installDir.toLowerCase()
      if (!installDir) return
      if (games.has(key)) {
        const kept = games.get(key)
        // A later uninstall row can be the only source of DisplayIcon after the manifest executable was unusable.
        if (kept && fallback?.iconPath && (!kept.iconPath || isHelperExecutable(kept.iconPath))) {
          const icon = await resolveEaFilePath(fallback.iconPath, installDir, deps.regQuery)
          if (icon && !isHelperExecutable(icon) && (await deps.exists(icon))) {
            kept.iconPath = icon
            kept.iconType = "fileicon"
          }
        }
        void deps.report?.("candidate_skipped", { installDir, reason: "duplicate_install_directory", keptId: kept?.id, incomingId: fallback?.id })
        return
      }
      let game = fallback || null
      const manifestPath = path.join(installDir, "__Installer", "installerdata.xml")
      try {
        const parsed = eaGameFromInstallerXml(await deps.readFile(manifestPath), installDir, deps.report)
        if (parsed) game = fallback ? { ...parsed, id: fallback.id, appid: fallback.appid } : parsed
      } catch (err) {
        void deps.report?.("ea_manifest_unavailable", { manifestPath, fallbackId: fallback?.id, ...errorDetails(err) })
      }
      if (!game) {
        void deps.report?.("candidate_skipped", { installDir, reason: "no_ea_registry_or_manifest_metadata" })
        return
      }
      game.installDir = installDir
      game.discoveryPath = manifestPath
      const registryIcon = fallback?.iconPath || ""
      const candidates = [game.iconPath, registryIcon]
      const exe = await existingExecutable(deps, candidates, installDir)
      if (!game.offerIds?.length) {
        game.launchUrl = exe || installDir
        if (!exe) game.launchError = "No executable or EA content ID was found for this installation"
      }
      game.iconPath = await gameIcon(deps, candidates, installDir)
      game.iconType = game.iconPath ? "fileicon" : ""
      games.set(key, game)
    }
    if (typeof deps.regQueryTree === "function") {
      const keys = ["EA Games", "Origin Games", "EA SPORTS", "Electronic Arts"].flatMap(key => [`HKLM\\SOFTWARE\\WOW6432Node\\${key}`, `HKLM\\SOFTWARE\\${key}`])
      for (const key of keys) {
        for (const game of eaGamesFromReg(parseRegTree(await deps.regQueryTree(key)), deps.report)) {
          await addDirectory(game.installDir, game)
        }
      }
      for (const key of ["HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"]) {
        const entries = parseRegTree(await deps.regQueryTree(key))
        const eaEntries = entries.filter(entry => /^(Electronic Arts|EA)(\b|\s|$)/i.test(entry.values.Publisher || "") && !EA_SKIP.test(entry.values.DisplayName || ""))
        void deps.report?.("ea_uninstall_registry", { registryKey: key, examined: entries.length, candidates: eaEntries.length })
        for (const game of eaGamesFromReg(eaEntries, deps.report)) await addDirectory(game.installDir, game)
      }
    }
    let inventory = { drives: [] as string[] }
    try {
      if (typeof deps.windowsInventory === "function") inventory = await deps.windowsInventory()
    } catch (err) {
      void deps.report?.("windows_inventory_failed", errorDetails(err), "Warning")
    }
    const roots = [
      path.join(deps.programFiles || "C:\\Program Files", "EA Games"),
      path.join(deps.programFilesX86 || "C:\\Program Files (x86)", "Origin Games"),
      ...(inventory.drives || []).flatMap(drive => [path.join(drive, "EA Games"), path.join(drive, "Origin Games")])
    ]
    void deps.report?.("ea_scan_roots", { roots: dedupePaths(roots, "win32") })
    for (const root of dedupePaths(roots, "win32")) {
      let names: string[] = []
      try {
        names = await deps.readdir(root)
      } catch {
        continue
      }
      watchDirs.push(root)
      for (const name of names) await addDirectory(path.join(root, name))
    }
    // Materialize after merging all registry rows so icon selection still compares source executables.
    for (const game of games.values()) {
      await applyGameIcon(deps, game)
    }
    return { games: [...games.values()], watchDirs }
  }
}
