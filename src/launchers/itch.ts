import path from "path"
import { errorDetails } from "../errors"
import { applyGameIcon } from "../files"
import { createGame } from "../game"
import { emptyScan, GameLauncher, InstalledGame, ScanDeps } from "../types"

export function itchExecutable(toml: string): string {
  const blocks = String(toml || "")
    .split(/\[\[actions\]\]/i)
    .slice(1)
  for (const block of blocks) {
    const target = /(?:^|\n)\s*path\s*=\s*"([^"]+)"/i.exec(block)
    if (target) return target[1].trim()
  }
  return ""
}

interface ItchRow {
  caveId?: unknown
  installDir?: unknown
  title?: unknown
}

export class ItchLauncher implements GameLauncher {
  readonly id = "itch"
  readonly label = "itch.io"

  async scan(deps: ScanDeps) {
    let DatabaseSync: typeof import("node:sqlite").DatabaseSync
    try {
      DatabaseSync = (await import("node:sqlite")).DatabaseSync
    } catch (err) {
      void deps.report?.("source_unavailable", { reason: "node_sqlite_unavailable", ...errorDetails(err) }, "Warning")
      return emptyScan()
    }
    const dbPath = path.join(deps.appData || "", "itch", "db", "butler.db")
    if (!dbPath || !(await deps.exists(dbPath))) return emptyScan()
    let rows: ItchRow[] = []
    let db: InstanceType<typeof DatabaseSync> | undefined
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
      rows = db.prepare("select caves.id as caveId, caves.install_folder_path as installDir, games.title as title from caves join games on games.id = caves.game_id").all() as ItchRow[]
      void deps.report?.("itch_database", { dbPath, rows: rows.length })
    } catch (err) {
      void deps.report?.("itch_database_failed", { dbPath, ...errorDetails(err) }, "Warning")
      return emptyScan()
    } finally {
      db?.close()
    }
    const games: InstalledGame[] = []
    for (const row of rows) {
      const installDir = String(row.installDir || "").trim()
      const name = String(row.title || "").trim()
      const caveId = String(row.caveId || "").trim()
      if (!installDir || !name || !caveId) {
        void deps.report?.("candidate_skipped", { caveId, name, installDir, reason: "missing_itch_metadata" }, "Warning")
        continue
      }
      let exeName = ""
      try {
        exeName = itchExecutable(await deps.readFile(path.join(installDir, ".itch.toml")))
      } catch {
        exeName = ""
      }
      const iconPath = exeName ? path.join(installDir, exeName) : ""
      const game = createGame("itch", {
        appid: caveId,
        name,
        installDir,
        discoveryPath: dbPath,
        launchUrl: `itch://caves/${caveId}/launch`,
        iconPath
      })
      if (game) {
        await applyGameIcon(deps, game)
        games.push(game)
      }
    }
    return { games, watchDirs: [path.dirname(dbPath)] }
  }
}
