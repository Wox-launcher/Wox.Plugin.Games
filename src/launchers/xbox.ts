import path from "path"
import { errorDetails } from "../errors"
import { createGame } from "../game"
import { dedupePaths } from "../paths"
import { parseRegTree } from "../registry"
import { xmlAttribute, xmlTag } from "../xml"
import { emptyScan, GameLauncher, InstalledGame, ScanDeps, ScanReport, WindowsApp } from "../types"

/** Same order the Apps plugin uses when it resolves a packaged app's Square44x44Logo. */
const LOGO_SCALES = ["scale-200", "scale-400", "scale-150", "scale-125", "scale-100", ""]
const LOGO_TARGET_SIZES = ["256", "64", "48", "44", "32", "24", "16"]

function logoVariants(logo: string): string[] {
  const normalized = logo.replace(/\//g, "\\")
  const parsed = path.win32.parse(normalized)
  const named = (fileName: string) => (parsed.dir ? path.win32.join(parsed.dir, fileName) : fileName)
  const variants: string[] = []
  for (const size of LOGO_TARGET_SIZES) {
    for (const scale of LOGO_SCALES) {
      variants.push(named(scale ? `${parsed.name}.targetsize-${size}.${scale}${parsed.ext}` : `${parsed.name}.targetsize-${size}${parsed.ext}`))
    }
  }
  for (const scale of LOGO_SCALES) variants.push(scale ? named(`${parsed.name}.${scale}${parsed.ext}`) : normalized)
  return variants
}

/** Shell logo files declared by MicrosoftGame.config, largest app-list size first. */
export function xboxIconCandidates(xml: string, installDir: string): string[] {
  const visuals = xmlTag(xml, "ShellVisuals")
  const executable = xmlTag(xml, "Executable")
  const logos = [
    xmlAttribute(executable, "OverrideSquare44x44Logo"),
    xmlAttribute(visuals, "Square44x44Logo"),
    xmlAttribute(executable, "OverrideLogo"),
    xmlAttribute(visuals, "Square150x150Logo"),
    xmlAttribute(visuals, "StoreLogo")
  ]
  const seen = new Set<string>()
  const files: string[] = []
  for (const logo of logos) {
    if (!logo) continue
    for (const variant of logoVariants(logo)) {
      const full = path.win32.isAbsolute(variant) ? variant : path.win32.join(installDir, variant)
      const key = full.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      files.push(full)
    }
  }
  return files
}

async function firstExisting(deps: ScanDeps, files: string[]): Promise<string> {
  for (const file of files) {
    if (await deps.exists(file)) return file
  }
  return ""
}

/** Match the manifest's application ID to a registered Shell entry before falling back to a raw exe. */
export function xboxGameFromConfig(xml: string, installDir: string, apps: WindowsApp[] = [], report?: ScanReport): InstalledGame | null {
  const name = xmlAttribute(xmlTag(xml, "ShellVisuals"), "DefaultDisplayName")
  const identity = xmlAttribute(xmlTag(xml, "Identity"), "Name")
  const exe = xmlTag(xml, "Executable")
  const exeName = xmlAttribute(exe, "Name")
  const exeId = xmlAttribute(exe, "Id")
  if (!name || !identity) {
    void report?.("candidate_skipped", { installDir, reason: "xbox_manifest_missing_identity_or_name", name, identity }, "Warning")
    return null
  }
  const familyApps = apps.filter(app =>
    String(app.appid || "")
      .toLowerCase()
      .startsWith(`${identity.toLowerCase()}_`)
  )
  const registered = familyApps.find(app => String(app.appid).toLowerCase().endsWith(`!${exeId.toLowerCase()}`)) || (familyApps.length === 1 ? familyApps[0] : null)
  const iconPath = exeName ? path.join(installDir, exeName) : ""
  void report?.(
    "xbox_manifest",
    { installDir, identity, exeId, executable: iconPath, registeredAppId: registered?.appid, familyAppIds: familyApps.map(app => app.appid) },
    registered ? "Info" : "Warning"
  )
  return createGame("xbox", {
    appid: identity,
    name,
    installDir,
    launchUrl: registered ? `shell:AppsFolder\\${registered.appid}` : iconPath || installDir,
    launchError: !registered && !iconPath ? "No registered Xbox application or executable was found" : "",
    iconPath
  })
}

export class XboxLauncher implements GameLauncher {
  readonly id = "xbox"
  readonly label = "Xbox"

  async scan(deps: ScanDeps) {
    if (deps.platform !== "win32") return emptyScan()
    let inventory = { apps: [] as WindowsApp[], drives: [] as string[], errors: [] as string[] }
    try {
      if (typeof deps.windowsInventory === "function") inventory = await deps.windowsInventory()
    } catch (err) {
      void deps.report?.("windows_inventory_failed", errorDetails(err), "Warning")
    }
    const roots = ["C:\\XboxGames", ...(inventory.drives || []).map(drive => path.join(drive, "XboxGames"))]
    if (typeof deps.regQueryTree === "function") {
      const output = await deps.regQueryTree("HKLM\\SOFTWARE\\Microsoft\\GamingServices")
      for (const entry of parseRegTree(output)) {
        for (const value of Object.values(entry.values)) {
          if (/^[a-zA-Z]:[\\/]/.test(value)) roots.push(value.trim())
        }
      }
    }
    const unique = dedupePaths(roots, deps.platform)
    const games: InstalledGame[] = []
    const watchDirs: string[] = []
    const candidates: string[] = []
    void deps.report?.("xbox_scan_roots", { roots: unique, registeredApps: inventory.apps.length })
    for (const root of unique) {
      let names: string[] = []
      try {
        names = await deps.readdir(root)
      } catch {
        continue
      }
      watchDirs.push(root)
      for (const name of names) candidates.push(path.join(root, name, "Content"), path.join(root, name))
    }
    // Registered packages also expose installations outside the conventional XboxGames directories.
    candidates.push(...inventory.apps.map(app => app.installDir || "").filter(Boolean))
    const seen = new Set<string>()
    for (const folder of dedupePaths(candidates, "win32")) {
      const config = path.join(folder, "MicrosoftGame.config")
      try {
        if (!(await deps.exists(config))) continue
        const xml = await deps.readFile(config)
        const game = xboxGameFromConfig(xml, folder, inventory.apps, deps.report)
        if (!game) continue
        if (seen.has(game.id)) {
          void deps.report?.("candidate_skipped", { config, id: game.id, reason: "duplicate_game_id" })
          continue
        }
        game.discoveryPath = config
        const logo = await firstExisting(deps, xboxIconCandidates(xml, folder))
        if (logo) {
          game.iconPath = logo
          game.iconType = "absolute"
        } else if (game.iconPath && !(await deps.exists(game.iconPath))) {
          game.iconPath = ""
          game.iconType = ""
        }
        seen.add(game.id)
        games.push(game)
      } catch (err) {
        void deps.report?.("manifest_failed", { config, ...errorDetails(err) }, "Warning")
      }
    }
    return { games, watchDirs }
  }
}
