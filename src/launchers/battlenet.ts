import { spawnSync } from "child_process"
import path from "path"
import { errorDetails } from "../errors"
import { applyGameIcon, primaryExe } from "../files"
import { createGame } from "../game"
import { displayIconPath, parseRegTree, RegEntry } from "../registry"
import { emptyScan, GameLauncher, InstalledGame, ScanDeps, ScanReport } from "../types"

/** A cold Battle.net process ignores `--exec` until its window exists. A tray client has no window but is already old enough to accept it. */
export const BATTLENET_READY_AGE_MS = 8000
export const BATTLENET_READY_TIMEOUT_MS = 45000
export const BATTLENET_READY_POLL_MS = 500

export type BattleNetClientState = "window" | "running" | "absent"

export interface BattleNetClientSnapshot {
  state: BattleNetClientState
  ageMs: number
}

export interface BattleNetLaunchDeps {
  open: (target: string, args?: string[]) => Promise<unknown>
  snapshot: () => Promise<BattleNetClientSnapshot>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  timeoutMs?: number
  pollMs?: number
  readyAgeMs?: number
}

export function parseBattleNetLaunchCode(args: string[]): string {
  return /^--exec=launch\s+(\S+)$/i.exec(String(args?.[0] || "").trim())?.[1] || ""
}

export function parseBattleNetSnapshot(output: string): BattleNetClientSnapshot {
  const lines = String(output || "")
    .replace(/\0/g, "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = /^(window|running|absent)(?:\s+(\d+))?$/i.exec(lines[index])
    if (!match) continue
    return { state: match[1].toLowerCase() as BattleNetClientState, ageMs: Number(match[2] || 0) }
  }
  return { state: "absent", ageMs: 0 }
}

/** One sample of the running client. `--exec` is ignored until this reports a window, or a client that was already up. */
export function readBattleNetClient(): BattleNetClientSnapshot {
  const script = [
    "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$procs = @(Get-Process -Name 'Battle.net' -ErrorAction SilentlyContinue)",
    "if ($procs.Count -eq 0) { 'absent 0'; exit 0 }",
    "$age = [int]((Get-Date) - @($procs | Sort-Object StartTime)[0].StartTime).TotalMilliseconds",
    "if (@($procs | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0) { 'window ' + $age; exit 0 }",
    "'running ' + $age"
  ].join("; ")
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 8000 })
  return parseBattleNetSnapshot(`${result.stdout || ""}\n${result.stderr || ""}`)
}

/**
 * Battle.net drops `--exec=launch` when the client is not already running.
 * Start it, wait until the window is up, then send the launch command.
 */
export async function launchBattleNetGame(exe: string, launchCode: string, deps: BattleNetLaunchDeps): Promise<{ mode: "ready" | "deferred"; sawWindow: boolean }> {
  const execArg = `--exec=launch ${launchCode}`
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const now = deps.now || Date.now
  const timeoutMs = deps.timeoutMs ?? BATTLENET_READY_TIMEOUT_MS
  const pollMs = deps.pollMs ?? BATTLENET_READY_POLL_MS
  const readyAgeMs = deps.readyAgeMs ?? BATTLENET_READY_AGE_MS
  const initial = await deps.snapshot()
  if (initial.state === "window") {
    await deps.open(exe, [execArg])
    return { mode: "ready", sawWindow: true }
  }
  const alreadyRunning = initial.state === "running"
  if (!alreadyRunning) await deps.open(exe, [])
  const deadline = now() + timeoutMs
  let sawWindow = false
  const maxPolls = Math.ceil(timeoutMs / pollMs) + 1
  for (let poll = 0; poll < maxPolls; poll++) {
    const snap = await deps.snapshot()
    if (snap.state === "window") {
      sawWindow = true
      break
    }
    if (alreadyRunning && snap.ageMs >= readyAgeMs) break
    if (now() >= deadline) break
    await sleep(pollMs)
  }
  await deps.open(exe, [execArg])
  return { mode: "deferred", sawWindow }
}

/** Install id, uninstall/client code, display name, and optional launch code when it differs. */
const BATTLENET_PRODUCTS: ReadonlyArray<readonly [string, string, string, string?]> = [
  ["wow", "WoW", "World of Warcraft"],
  ["wow_classic", "WoW_wow_classic", "World of Warcraft Classic"],
  ["wow_classic_era", "WoW_wow_classic_era", "World of Warcraft Classic Era"],
  ["pro", "Pro", "Overwatch"],
  ["s1", "S1", "StarCraft"],
  ["s2", "S2", "StarCraft II"],
  ["d3", "D3", "Diablo III"],
  ["d3cn", "D3CN", "Diablo III"],
  ["hsb", "hsb", "Hearthstone", "WTCG"],
  ["hs", "hsb", "Hearthstone", "WTCG"],
  ["hero", "Hero", "Heroes of the Storm"],
  ["fenris", "Fen", "Diablo IV"],
  ["osi", "OSI", "Diablo II: Resurrected"],
  ["w1", "W1", "Warcraft: Orcs & Humans"],
  ["w1r", "W1R", "Warcraft I: Remastered"],
  ["w2bn", "W2BN", "Warcraft II: Battle.net Edition"],
  ["w2r", "W2R", "Warcraft II: Remastered"],
  ["w3", "W3", "Warcraft III"],
  ["gryphon", "GRY", "Warcraft Rumble"],
  ["viper", "VIPR", "Call of Duty: Black Ops 4"],
  ["odin", "ODIN", "Call of Duty: Modern Warfare"],
  ["lazarus", "LAZR", "Call of Duty: Modern Warfare 2 Campaign Remastered"],
  ["zeus", "ZEUS", "Call of Duty: Black Ops Cold War"],
  ["auks", "AUKS", "Call of Duty: Modern Warfare II"],
  ["codhq", "CODHQ", "Call of Duty HQ"],
  ["rtro", "RTRO", "Blizzard Arcade Collection"],
  ["wlby", "WLBY", "Crash Bandicoot 4"],
  ["fore", "FORE", "Call of Duty: Vanguard"],
  ["anbs", "ANBS", "Diablo Immortal"],
  ["dst2", "DST2", "Destiny 2"]
]

interface BattleNetAggregate {
  installed?: Array<{
    name?: string
    product_id?: string
    launch_uri?: string
    icon_path?: string
  }>
}

export function battleNetGamesFromAggregate(data: BattleNetAggregate | null, clientExe: string, report?: ScanReport): InstalledGame[] {
  const installed = data && Array.isArray(data.installed) ? data.installed : []
  const games: InstalledGame[] = []
  for (const item of installed) {
    const name = String(item.name || "").trim()
    const appid = String(item.product_id || "").trim()
    const protocol = String(item.launch_uri || "").trim()
    if (!name || !appid || appid.toLowerCase() === "battle.net") {
      void report?.("candidate_skipped", { name, appid, reason: appid.toLowerCase() === "battle.net" ? "launcher_itself" : "missing_game_identity" })
      continue
    }
    const iconPath = String(item.icon_path || "")
      .trim()
      .replace(/\//g, "\\")
    // Install IDs and client launch codes differ for some games (hsb uses WTCG).
    const known = BATTLENET_PRODUCTS.find(product => product[0] === appid.toLowerCase())
    const launchCode = known ? known[3] || known[1] : appid
    const launchUrl = clientExe || iconPath || protocol
    const launchArgs = clientExe ? [`--exec=launch ${launchCode}`] : []
    void report?.("battlenet_launch_mapping", { appid, launchCode, clientExe, protocol, fallbackToStub: !clientExe, known: !!known }, clientExe ? "Info" : "Warning")
    const game = createGame("battlenet", {
      appid,
      name,
      installDir: iconPath ? path.dirname(iconPath) : "",
      launchUrl,
      launchArgs,
      iconPath
    })
    if (game) games.push(game)
  }
  return games
}

export function battleNetGamesFromReg(entries: RegEntry[], clientExe = "", report?: ScanReport): InstalledGame[] {
  const games: InstalledGame[] = []
  for (const entry of entries) {
    const values = entry.values || {}
    const uninstall = String(values.UninstallString || "")
    const uid = /--uid=([^\s"]+)/i.exec(uninstall)
    if (!uid) continue
    const uidValue = uid[1].toLowerCase()
    if (uidValue === "battle.net" || uidValue.startsWith("battle.net")) continue
    const displayName = String(values.DisplayName || "").trim()
    if (!displayName || /test$|beta$/i.test(displayName)) {
      void report?.("candidate_skipped", { registryKey: entry.key, uid: uidValue, name: displayName, reason: !displayName ? "missing_game_name" : "test_or_beta_game" })
      continue
    }
    const internal = uidValue.split("_")[0]
    // Keep IDs such as wow_classic intact, then allow uninstall suffixes such as hs_beta.
    const known = BATTLENET_PRODUCTS.find(item => item[0] === uidValue) || BATTLENET_PRODUCTS.find(item => item[0] === internal)
    const installDir = String(values.InstallLocation || "").trim()
    const appid = known ? known[1] : internal
    const launchCode = known ? known[3] || known[1] : appid
    const game = createGame("battlenet", {
      appid,
      name: displayName || (known ? known[2] : internal),
      installDir,
      launchUrl: clientExe || `battlenet://game/${appid}`,
      launchArgs: clientExe ? [`--exec=launch ${launchCode}`] : [],
      discoveryPath: entry.key,
      iconPath: displayIconPath(values.DisplayIcon)
    })
    if (game) games.push(game)
  }
  return games
}

async function findBattleNetClient(deps: ScanDeps): Promise<string> {
  const roots = [path.join(deps.programFilesX86 || "C:\\Program Files (x86)", "Battle.net", "Battle.net.exe"), path.join(deps.programFiles || "C:\\Program Files", "Battle.net", "Battle.net.exe")]
  for (const candidate of roots) {
    if (await deps.exists(candidate)) return candidate
  }
  return ""
}

export class BattleNetLauncher implements GameLauncher {
  readonly id = "battlenet"
  readonly label = "Battle.net"

  async scan(deps: ScanDeps) {
    if (deps.platform !== "win32") return emptyScan()
    const clientExe = await findBattleNetClient(deps)
    const catalog = path.join(deps.programData || "C:\\ProgramData", "Battle.net", "Agent", "aggregate.json")
    try {
      const games = battleNetGamesFromAggregate(JSON.parse(await deps.readFile(catalog)) as BattleNetAggregate, clientExe, deps.report)
      for (const game of games) {
        game.discoveryPath = catalog
        await applyGameIcon(deps, game)
      }
      if (games.length) return { games, watchDirs: [path.dirname(catalog)] }
    } catch (err) {
      // Older clients only list games in the uninstall registry.
      void deps.report?.("battlenet_registry_fallback", { catalog, ...errorDetails(err) })
    }
    if (typeof deps.regQueryTree !== "function") return emptyScan()
    const trees = await Promise.all([
      deps.regQueryTree("HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
      deps.regQueryTree("HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall")
    ])
    const games: InstalledGame[] = []
    const seen = new Set<string>()
    for (const output of trees) {
      for (const game of battleNetGamesFromReg(parseRegTree(output), clientExe, deps.report)) {
        if (seen.has(game.id)) {
          void deps.report?.("candidate_skipped", { id: game.id, reason: "duplicate_game_id" })
          continue
        }
        if (!game.iconPath || !(await deps.exists(game.iconPath))) {
          game.iconPath = await primaryExe(deps, game.installDir)
          game.iconType = game.iconPath ? "fileicon" : ""
        }
        seen.add(game.id)
        await applyGameIcon(deps, game)
        games.push(game)
      }
    }
    return { games, watchDirs: [] }
  }
}
