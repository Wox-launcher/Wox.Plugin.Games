import path from "path"
import { errorDetails } from "../errors"
import { createGame } from "../game"
import { emptyScan, GameLauncher, InstalledGame, ScanDeps, ScanReport } from "../types"

interface EpicManifest {
  bIsIncompleteInstall?: boolean
  DisplayName?: string
  AppName?: string
  CatalogNamespace?: string
  CatalogItemId?: string
  InstallLocation?: string
  AppCategories?: unknown[]
  LaunchExecutable?: string
}

export function epicGameFromManifest(data: EpicManifest | null, report?: ScanReport): InstalledGame | null {
  if (!data || typeof data !== "object") return null
  if (data.bIsIncompleteInstall === true) {
    void report?.("candidate_skipped", { name: data.DisplayName, reason: "incomplete_install" })
    return null
  }
  const name = String(data.DisplayName || "").trim()
  const appName = String(data.AppName || "").trim()
  const namespace = String(data.CatalogNamespace || "").trim()
  const catalog = String(data.CatalogItemId || "").trim()
  const installDir = String(data.InstallLocation || "").trim()
  if (!name || !appName || !namespace || !catalog) {
    void report?.("candidate_skipped", { name, appName, namespace, catalog, installDir, reason: "missing_epic_identity_fields" }, "Warning")
    return null
  }
  const categories = Array.isArray(data.AppCategories) ? data.AppCategories.map(value => String(value).toLowerCase()) : []
  if (categories.length && !categories.includes("games")) {
    void report?.("candidate_skipped", { name, appName, categories, reason: "not_a_game" })
    return null
  }
  const exeName = String(data.LaunchExecutable || "").trim()
  const iconPath = exeName && installDir ? path.join(installDir, exeName) : ""
  return createGame("epic", {
    appid: appName,
    name,
    installDir,
    launchUrl: `com.epicgames.launcher://apps/${namespace}%3A${catalog}%3A${appName}?action=launch&silent=true`,
    iconPath
  })
}

export class EpicLauncher implements GameLauncher {
  readonly id = "epic"
  readonly label = "Epic"

  async scan(deps: ScanDeps) {
    if (deps.platform !== "win32") return emptyScan()
    const dir = path.join(deps.programData || "C:\\ProgramData", "Epic", "EpicGamesLauncher", "Data", "Manifests")
    let names: string[] = []
    try {
      names = await deps.readdir(dir)
    } catch {
      return emptyScan()
    }
    const games: InstalledGame[] = []
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".item")) continue
      const manifestPath = path.join(dir, name)
      try {
        const game = epicGameFromManifest(JSON.parse(await deps.readFile(manifestPath)) as EpicManifest, (event, fields, level) => deps.report?.(event, { manifestPath, ...fields }, level))
        if (!game) continue
        game.discoveryPath = manifestPath
        if (game.iconPath && !(await deps.exists(game.iconPath))) {
          game.iconPath = ""
          game.iconType = ""
        }
        games.push(game)
      } catch (err) {
        void deps.report?.("manifest_failed", { manifestPath, ...errorDetails(err) }, "Warning")
      }
    }
    return { games, watchDirs: [dir] }
  }
}
