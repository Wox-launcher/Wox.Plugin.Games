import { randomUUID } from "crypto"
import { PLUGIN_VERSION } from "./constants"
import { errorCode, errorDetails } from "./errors"
import { isGameRecord } from "./game"
import { createLaunchers } from "./launchers"
import { compareName } from "./match"
import { dedupePaths } from "./paths"
import { parseRegTree } from "./registry"
import { GameLauncher, InstalledGame, LogLevel, ScanAllResult, ScanDeps, ScanReport, WindowsInventory } from "./types"

async function tracedCall<Value>(report: ScanReport, operation: string, args: unknown[], run: () => Promise<Value>, summarize: (value: Value) => unknown, exists = false): Promise<Value> {
  const started = Date.now()
  await report("scan_io_start", { operation, args })
  try {
    const value = await run()
    await report("scan_io_done", { operation, args, durationMs: Date.now() - started, result: summarize(value) })
    return value
  } catch (err) {
    const code = errorCode(err)
    await report("scan_io_failed", { operation, args, durationMs: Date.now() - started, ...errorDetails(err) }, code === "ENOENT" || code === "ENOTDIR" ? "Info" : "Warning")
    // An inaccessible optional icon or directory must not discard the source's other games.
    if (exists) return false as Value
    throw err
  }
}

/** Record I/O at the source boundary so caught read errors remain visible for every launcher. */
export function traceScanDeps(deps: ScanDeps, report: ScanReport): ScanDeps {
  return {
    ...deps,
    report,
    readFile: file =>
      tracedCall(
        report,
        "readFile",
        [file],
        () => deps.readFile(file, report),
        value => ({ bytes: Buffer.byteLength(String(value)) })
      ),
    readBinary: deps.readBinary
      ? file =>
          tracedCall(
            report,
            "readBinary",
            [file],
            () => deps.readBinary!(file, report),
            value => ({ bytes: value.length })
          )
      : undefined,
    writeBinary: deps.writeBinary
      ? (file, data) =>
          tracedCall(
            report,
            "writeBinary",
            [file],
            () => deps.writeBinary!(file, data, report),
            () => ({ bytes: data.length })
          )
      : undefined,
    readdir: dir =>
      tracedCall(
        report,
        "readdir",
        [dir],
        () => deps.readdir(dir, report),
        value => value
      ),
    exists: file =>
      tracedCall(
        report,
        "exists",
        [file],
        () => deps.exists(file, report),
        value => value,
        true
      ),
    regQuery: (key, valueName) =>
      tracedCall(
        report,
        "regQuery",
        [key, valueName],
        () => deps.regQuery(key, valueName, report),
        value => value
      ),
    regQueryTree: key =>
      tracedCall(
        report,
        "regQueryTree",
        [key],
        () => deps.regQueryTree(key, report),
        value => ({
          entries: parseRegTree(value).length,
          bytes: Buffer.byteLength(String(value))
        })
      ),
    windowsInventory: () =>
      tracedCall(
        report,
        "windowsInventory",
        [],
        () => deps.windowsInventory(report),
        (value: WindowsInventory) => ({
          drives: value.drives,
          registeredApps: value.apps.length,
          errors: value.errors
        })
      )
  }
}

/** Keeps one launcher failure from dropping the games found by the others. */
export async function scanAll(deps: ScanDeps, launchers: readonly GameLauncher[] = createLaunchers()): Promise<ScanAllResult> {
  const games: InstalledGame[] = []
  const watchDirs: string[] = []
  const seen = new Set<string>()
  const scanId = randomUUID()
  const started = Date.now()
  let inventory: Promise<WindowsInventory> | undefined
  const shared: ScanDeps = { ...deps }
  if (typeof deps.windowsInventory === "function") {
    const loadInventory = deps.windowsInventory
    shared.windowsInventory = report => (inventory ||= loadInventory(report))
  }
  const log = async (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    try {
      await deps.log?.(level, event, { scanId, ...fields })
    } catch {
      /* Diagnostics must not stop indexing. */
    }
  }
  await log("Info", "scan_start", { version: PLUGIN_VERSION, platform: deps.platform, nodeVersion: process.version })
  for (const source of launchers) {
    const pendingLogs: Array<Promise<unknown>> = []
    const report: ScanReport = (event, fields, level = "Info") => {
      const pending = log(level, event, { source: source.id, ...fields })
      pendingLogs.push(pending)
      return pending
    }
    const sourceStart = Date.now()
    await log("Info", "source_scan_start", { source: source.id })
    try {
      const found = await source.scan(traceScanDeps(shared, report))
      for (const dir of found.watchDirs || []) watchDirs.push(dir)
      for (const candidate of found.games || []) {
        const game = candidate as unknown
        if (!isGameRecord(game) || seen.has(game.id)) {
          const record = (typeof game === "object" && game ? game : {}) as Partial<InstalledGame>
          void report("candidate_skipped", { id: record.id, name: record.name, reason: isGameRecord(game) ? "duplicate_game_id" : "invalid_game_record" })
          continue
        }
        seen.add(game.id)
        games.push(game)
        void report("game_indexed", {
          id: game.id,
          name: game.name,
          installDir: game.installDir,
          discoveryPath: game.discoveryPath,
          launchUrl: game.launchUrl,
          launchArgs: game.launchArgs,
          launchError: game.launchError,
          iconPath: game.iconPath
        })
      }
      void report("source_scan_done", { games: found.games.length, watchDirs: found.watchDirs || [], durationMs: Date.now() - sourceStart })
    } catch (err) {
      void report("source_scan_failed", { durationMs: Date.now() - sourceStart, ...errorDetails(err) }, "Error")
    }
    await Promise.all(pendingLogs)
  }
  games.sort((a, b) => compareName(a.name, b.name))
  await log("Info", "scan_done", { games: games.length, durationMs: Date.now() - started })
  return { games, watchDirs: dedupePaths(watchDirs, deps.platform), scanId }
}
