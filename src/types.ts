export type LogLevel = "Info" | "Error" | "Debug" | "Warning"

export type ScanReport = (event: string, fields?: Record<string, unknown>, level?: LogLevel) => void | Promise<unknown>

export interface InstalledGame {
  id: string
  source: string
  appid: string
  name: string
  libraryPath: string
  steamRoot: string
  installDir: string
  launchUrl: string
  launchArgs: string[]
  offerIds: string[]
  discoveryPath: string
  launchError: string
  storeUrl: string
  iconPath: string
  iconType: string
}

export interface GameDraft {
  appid?: string
  name?: string
  installDir?: string
  libraryPath?: string
  steamRoot?: string
  launchUrl?: string
  launchArgs?: string[]
  offerIds?: string[]
  discoveryPath?: string
  launchError?: string
  storeUrl?: string
  iconPath?: string
  iconType?: string
}

export interface WindowsApp {
  name?: string
  appid: string
  family?: string
  installDir?: string
}

export interface WindowsInventory {
  apps: WindowsApp[]
  drives: string[]
  errors: string[]
}

/** IO available to a launcher. Launchers do not touch the filesystem, registry, or process table directly. */
export interface ScanDeps {
  platform: NodeJS.Platform
  homedir: string
  appData: string
  publicDir: string
  programData: string
  programFiles: string
  programFilesX86: string
  exists: (file: string, report?: ScanReport) => Promise<boolean>
  readFile: (file: string, report?: ScanReport) => Promise<string>
  /** Icon files are binary. Text reads replace bytes that are not valid UTF-8. */
  readBinary?: (file: string, report?: ScanReport) => Promise<Buffer>
  /** Plugin cache from GetCacheFolder. Launchers write derived icons here. */
  cacheDir?: string
  writeBinary?: (file: string, data: Buffer, report?: ScanReport) => Promise<void>
  readdir: (dir: string, report?: ScanReport) => Promise<string[]>
  regQuery: (key: string, valueName: string, report?: ScanReport) => Promise<string>
  regQueryTree: (key: string, report?: ScanReport) => Promise<string>
  windowsInventory: (report?: ScanReport) => Promise<WindowsInventory>
  report?: ScanReport
  log?: (level: LogLevel, event: string, fields?: Record<string, unknown>) => Promise<void>
}

export interface LauncherScan {
  games: InstalledGame[]
  watchDirs: string[]
}

/** One installed-game catalog. `scan` returns games and directories worth watching for changes. */
export interface GameLauncher {
  readonly id: string
  readonly label: string
  scan(deps: ScanDeps): Promise<LauncherScan>
}

export interface ScanAllResult {
  games: InstalledGame[]
  watchDirs: string[]
  scanId: string
}

export function emptyScan(): LauncherScan {
  return { games: [], watchDirs: [] }
}
