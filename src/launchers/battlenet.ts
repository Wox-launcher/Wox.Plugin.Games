import path from "path"
import { errorDetails } from "../errors"
import { primaryExe } from "../files"
import { createGame } from "../game"
import { displayIconPath, parseRegTree, RegEntry } from "../registry"
import { emptyScan, GameLauncher, InstalledGame, ScanDeps, ScanReport } from "../types"

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
        if (game.iconPath && !(await deps.exists(game.iconPath))) {
          game.iconPath = ""
          game.iconType = ""
        }
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
        games.push(game)
      }
    }
    return { games, watchDirs: [] }
  }
}
