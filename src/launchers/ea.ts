import path from "path"
import { errorDetails } from "../errors"
import { primaryExe } from "../files"
import { createGame } from "../game"
import { dedupePaths } from "../paths"
import { leafKey, parseRegTree, RegEntry } from "../registry"
import { decodeXmlText } from "../xml"
import { emptyScan, GameLauncher, InstalledGame, ScanDeps, ScanReport } from "../types"

const EA_SKIP = /^(ea desktop|ea core|ea app|origin|eacore)$/i

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
      offerIds: offerId ? [offerId] : []
    })
    void report?.("ea_registry_candidate", { registryKey: entry.key, name, installDir, offerId })
    if (game) games.push(game)
  }
  return games
}

export function eaGameFromInstallerXml(xml: string, installDir: string, report?: ScanReport): InstalledGame | null {
  const name = /<gameTitle[^>]*>([^<]+)<\/gameTitle>/i.exec(xml)
  const offerIds = uniqueContentIds(xml)
  const filePath = /<filePath>([^<]+)<\/filePath>/i.exec(xml)
  if (!name) {
    void report?.("candidate_skipped", { installDir, reason: "installer_xml_missing_game_title" }, "Warning")
    return null
  }
  const exeName = filePath ? decodeXmlText(filePath[1]).replace(/^\[INSTALLDIR\][\\/]?/i, "") : ""
  const iconPath = exeName ? (path.win32.isAbsolute(exeName) ? exeName : path.join(installDir, exeName)) : ""
  void report?.("ea_manifest", { installDir, name: decodeXmlText(name[1]), offerIds, executable: iconPath })
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
        void deps.report?.("candidate_skipped", { installDir, reason: "duplicate_install_directory", keptId: games.get(key)?.id, incomingId: fallback?.id })
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
      if (!game.offerIds?.length) {
        const exe = game.iconPath && (await deps.exists(game.iconPath)) ? game.iconPath : await primaryExe(deps, installDir)
        game.launchUrl = exe || installDir
        game.iconPath = exe
        if (!exe) game.launchError = "No executable or EA content ID was found for this installation"
      }
      if (game.iconPath && !(await deps.exists(game.iconPath))) game.iconPath = ""
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
    return { games: [...games.values()], watchDirs }
  }
}
