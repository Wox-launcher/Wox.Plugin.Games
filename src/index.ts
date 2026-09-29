import { Context, Plugin, PluginInitParams, PublicAPI, Query, QueryResponse, Result } from "@wox-launcher/wox-plugin"
import { randomUUID } from "crypto"
import fs from "fs"
import path from "path"
import { CACHE_FILE, CACHE_VERSION, EMPTY_RETRY_MS, FALLBACK_MS, FAVORITES_KEY, GLOBAL_RESULT_LIMIT, PLUGIN_VERSION, WATCH_DEBOUNCE_MS } from "./constants"
import { createScanDeps } from "./deps"
import { errorDetails, errorText } from "./errors"
import { isGameRecord, normalizeGame, parseFavorites } from "./game"
import { openExternal, OpenExternalOptions } from "./launch"
import { createLaunchers } from "./launchers"
import { matchGames } from "./match"
import { dedupePaths } from "./paths"
import { buildResult, ResultHooks } from "./results"
import { scanAll } from "./scan"
import { GameLauncher, InstalledGame, LogLevel, ScanDeps } from "./types"

export interface GamesPluginOptions {
  deps?: ScanDeps
  launchers?: GameLauncher[]
  openExternal?: (target: string, args?: string[], options?: OpenExternalOptions) => Promise<unknown>
  favorites?: string[]
  games?: InstalledGame[]
}

interface GameCache {
  version?: number
  scanId?: string
  games?: unknown[]
}

function isGlobalQuery(query: Query | undefined): boolean {
  if (!query) return false
  if (typeof query.IsGlobalQuery === "function") return query.IsGlobalQuery() === true
  return false
}

function querySearch(query: Query | undefined): string {
  return String(query?.Search || "").trim()
}

/**
 * Installed games are indexed in the background. Queries answer from memory.
 * The global "*" trigger is declared in plugin.json. RegisterTriggerKeyword rejects "*".
 */
export class GamesPlugin implements Plugin {
  private api: PublicAPI | null = null
  private ctx: Context | null = null
  private cacheDir = ""
  private readonly deps: ScanDeps
  private readonly launchers: GameLauncher[]
  private readonly openExternal: (target: string, args?: string[], options?: OpenExternalOptions) => Promise<unknown>
  private games: InstalledGame[] = []
  private byId = new Map<string, InstalledGame>()
  private watchers: fs.FSWatcher[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private timerDelay = 0
  private libraryCount = 0
  private favorites: string[]
  private debounce: ReturnType<typeof setTimeout> | null = null
  private refreshing: Promise<void> | null = null
  private ignoreWatchUntil = 0
  private scanId = ""
  private lastQueryLog = ""

  constructor(options: GamesPluginOptions = {}) {
    this.deps = options.deps || createScanDeps()
    this.launchers = options.launchers || createLaunchers()
    this.openExternal = options.openExternal || openExternal
    this.favorites = parseFavorites(JSON.stringify(options.favorites || []))
    if (options.games) this.replaceGames(options.games)
    // The host calls init and query unbound.
    this.init = this.init.bind(this)
    this.query = this.query.bind(this)
  }

  replaceGames(games: unknown): void {
    const next = Array.isArray(games) ? games.filter(isGameRecord).map(normalizeGame) : []
    this.games = next
    this.byId = new Map(next.map(game => [game.id, game]))
  }

  async init(ctx: Context, params: PluginInitParams): Promise<void> {
    this.api = params && params.API
    this.ctx = ctx
    await this.log(ctx, "Info", "plugin_init", {
      version: PLUGIN_VERSION,
      platform: process.platform,
      nodeVersion: process.version,
      programData: this.deps.programData,
      programFiles: this.deps.programFiles,
      programFilesX86: this.deps.programFilesX86
    })
    if (this.api && typeof this.api.GetCacheFolder === "function") {
      try {
        this.cacheDir = String((await this.api.GetCacheFolder(ctx)) || "")
      } catch (err) {
        await this.log(ctx, "Debug", `cache folder unavailable: ${errorText(err)}`)
      }
    }
    await this.loadCache()
    if (this.api && typeof this.api.GetSetting === "function") {
      try {
        this.favorites = parseFavorites(await this.api.GetSetting(ctx, FAVORITES_KEY))
      } catch (err) {
        await this.log(ctx, "Debug", `favorites unavailable: ${errorText(err)}`)
      }
    }
    if (this.api && typeof this.api.OnSettingChanged === "function") {
      await this.api.OnSettingChanged(ctx, (_callbackCtx, key, value) => {
        if (key === FAVORITES_KEY) this.favorites = parseFavorites(value)
      })
    }
    if (this.api && typeof this.api.OnMRURestore === "function") {
      await this.api.OnMRURestore(ctx, async (_restoreCtx, mruData) => this.restoreResult(mruData.ContextData))
    }
    if (this.api && typeof this.api.OnUnload === "function") {
      await this.api.OnUnload(ctx, async () => this.stop())
    }
    await this.registerTools(ctx)
    this.scheduleInterval()
    void this.refresh()
  }

  /** Keep looking while no library is installed yet. Once a library is found, the directory watch covers new games. */
  scheduleInterval(): void {
    const delay = this.libraryCount > 0 ? FALLBACK_MS : EMPTY_RETRY_MS
    if (this.timer && this.timerDelay === delay) return
    if (this.timer) clearInterval(this.timer)
    this.timerDelay = delay
    this.timer = setInterval(() => {
      void this.refresh()
    }, delay)
    if (typeof this.timer.unref === "function") this.timer.unref()
  }

  /** Rebuilds one row from the indexed snapshot. It must not scan disk or call the host. */
  restoreResult(contextData: { id?: string } | undefined): Result | null {
    const game = this.byId.get(String(contextData?.id || ""))
    if (!game) return null
    return buildResult(game, 1, this.hooks())
  }

  async query(ctx: Context, query: Query): Promise<QueryResponse> {
    if (this.games.length === 0) void this.refresh()
    const global = isGlobalQuery(query)
    const matched = matchGames(this.games, querySearch(query), { global, limit: GLOBAL_RESULT_LIMIT })
    const hooks = this.hooks()
    // Only keyword and scoped searches group games by launcher.
    const group = !global
    const queryDetails = {
      search: querySearch(query),
      global,
      indexed: this.games.length,
      matches: matched.map(item => item.game.id),
      scanId: this.scanId,
      refreshing: !!this.refreshing
    }
    const signature = JSON.stringify(queryDetails)
    if (queryDetails.search && signature !== this.lastQueryLog) {
      this.lastQueryLog = signature
      await this.log(ctx, "Info", "query_results", queryDetails)
    }
    return {
      Results: matched.map((item, index) => buildResult(item.game, item.score > 0 ? item.score : 1000 - index, hooks, { group }))
    }
  }

  private hooks(): ResultHooks {
    return {
      launch: async (ctx, game) => {
        try {
          await this.launchGame(ctx, game)
        } catch {
          if (this.api?.Notify) {
            const message = this.api.GetTranslation ? await this.api.GetTranslation(ctx, "error_launch_failed") : "Unable to launch the game. See the Wox log for details."
            await this.api.Notify(ctx, `${game.name}: ${message}`)
          }
        }
      },
      open: async (ctx, target) => {
        try {
          await this.log(ctx, "Info", "open_requested", { target })
          await this.openExternal(target, [], { report: (event, fields, level = "Info") => this.log(ctx, level, event, { target, ...fields }) })
        } catch (err) {
          await this.log(ctx, "Error", "open_failed", { target, ...errorDetails(err) })
        }
      },
      copy: async (ctx, text) => {
        if (!this.api || typeof this.api.Copy !== "function") return
        try {
          await this.api.Copy(ctx, { type: "text", text })
        } catch (err) {
          await this.log(ctx, "Error", `copy failed: ${errorText(err)}`)
        }
      },
      isFavorite: id => this.favorites.includes(id),
      favorite: async (ctx, id) => this.toggleFavorite(ctx, id)
    }
  }

  /** Both result actions and plugin tools use the same dispatch and failure logging. */
  async launchGame(ctx: Context, indexedGame: InstalledGame): Promise<void> {
    const game = this.byId.get(indexedGame.id) || indexedGame
    const launchId = randomUUID()
    const details = {
      launchId,
      scanId: this.scanId,
      id: game.id,
      source: game.source,
      name: game.name,
      installDir: game.installDir,
      discoveryPath: game.discoveryPath,
      target: game.launchUrl,
      args: game.launchArgs || []
    }
    await this.log(ctx, "Info", "launch_requested", details)
    try {
      if (game.launchError) throw new Error(game.launchError)
      const pendingLogs: Array<Promise<unknown>> = []
      const report = (event: string, fields?: Record<string, unknown>, level: LogLevel = "Info") => {
        const pending = this.log(ctx, level, event, { ...details, ...fields })
        pendingLogs.push(pending)
      }
      try {
        const result = await this.openExternal(game.launchUrl, game.launchArgs, { isLaunch: true, report })
        await this.log(ctx, "Info", "launch_dispatched", { ...details, ...(result && typeof result === "object" ? result : {}), gameStartConfirmed: false })
      } finally {
        await Promise.all(pendingLogs)
      }
    } catch (err) {
      await this.log(ctx, "Error", "launch_failed", { ...details, ...errorDetails(err) })
      throw err
    }
  }

  /** Keeps the newest favorite first so the Favorites group stays in that order. */
  async toggleFavorite(ctx: Context, id: string): Promise<void> {
    const next = this.favorites.filter(item => item !== id)
    if (next.length === this.favorites.length) next.unshift(id)
    this.favorites = next
    if (this.api && typeof this.api.SetSetting === "function") {
      try {
        await this.api.SetSetting(ctx, { Key: FAVORITES_KEY, Value: JSON.stringify(next), IsLocal: true })
      } catch (err) {
        await this.log(ctx, "Error", `favorite save failed: ${errorText(err)}`)
      }
    }
    if (this.api && typeof this.api.RefreshQuery === "function") {
      await this.api.RefreshQuery(ctx, { PreserveSelectedIndex: true })
    }
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.scanAndStore().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async scanAndStore(): Promise<void> {
    try {
      const found = await scanAll({ ...this.deps, log: (level, event, fields) => this.log(this.ctx, level, event, fields) }, this.launchers)
      this.scanId = found.scanId
      this.libraryCount = found.watchDirs.length || (found.games.length ? 1 : 0)
      this.replaceGames(found.games)
      await this.writeCache()
      this.rewatch(found.watchDirs)
      this.scheduleInterval()
      await this.log(this.ctx, "Info", `games indexed ${found.games.length} from ${found.watchDirs.length} libraries`)
    } catch (err) {
      await this.log(this.ctx, "Error", `games scan failed: ${errorText(err)}`)
    }
  }

  private async loadCache(): Promise<void> {
    if (!this.cacheDir) return
    const file = path.join(this.cacheDir, CACHE_FILE)
    try {
      const raw = JSON.parse(await fs.promises.readFile(file, "utf8")) as GameCache
      if (!raw || raw.version !== CACHE_VERSION || !Array.isArray(raw.games)) {
        await this.log(this.ctx, "Info", "cache_ignored", { file, cachedVersion: raw?.version, expectedVersion: CACHE_VERSION })
        return
      }
      this.replaceGames(raw.games)
      this.scanId = raw.scanId || ""
      await this.log(this.ctx, "Info", "cache_loaded", { file, games: this.games.length, version: raw.version })
    } catch (err) {
      await this.log(this.ctx, "Info", "cache_unavailable", { file, ...errorDetails(err) })
    }
  }

  private async writeCache(): Promise<void> {
    if (!this.cacheDir) return
    const file = path.join(this.cacheDir, CACHE_FILE)
    try {
      await fs.promises.mkdir(this.cacheDir, { recursive: true })
      await fs.promises.writeFile(file, JSON.stringify({ version: CACHE_VERSION, scanId: this.scanId, games: this.games }))
      await this.log(this.ctx, "Info", "cache_written", { file, games: this.games.length, version: CACHE_VERSION, scanId: this.scanId })
    } catch (err) {
      await this.log(this.ctx, "Warning", "cache_write_failed", { file, ...errorDetails(err) })
    }
  }

  /** Listens to each library directory that receives install manifests. */
  private rewatch(directories: string[]): void {
    this.ignoreWatchUntil = Date.now() + 500
    this.closeWatchers()
    for (const dir of dedupePaths(directories, this.deps.platform)) {
      try {
        const watcher = fs.watch(dir, { persistent: false }, () => this.onLibraryChange())
        watcher.on("error", err => void this.log(this.ctx, "Warning", "watch_failed", { directory: dir, ...errorDetails(err) }))
        if (typeof watcher.unref === "function") watcher.unref()
        this.watchers.push(watcher)
      } catch (err) {
        void this.log(this.ctx, "Warning", "watch_failed", { directory: dir, ...errorDetails(err) })
      }
    }
  }

  private onLibraryChange(): void {
    if (Date.now() < this.ignoreWatchUntil) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.refresh()
    }, WATCH_DEBOUNCE_MS)
    if (this.debounce && typeof this.debounce.unref === "function") this.debounce.unref()
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close()
      } catch {
        /* already closed */
      }
    }
    this.watchers = []
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    this.closeWatchers()
  }

  private async log(ctx: Context | null, level: LogLevel, message: string, fields?: Record<string, unknown>): Promise<void> {
    if (!this.api || typeof this.api.Log !== "function") return
    try {
      await this.api.Log(ctx || this.ctx || ({} as Context), level, fields ? `${message} ${JSON.stringify(fields)}` : message)
    } catch {
      // Logging must not break a scan.
    }
  }

  private async registerTools(ctx: Context): Promise<void> {
    if (!this.api || typeof this.api.RegisterPluginTool !== "function") return
    await this.registerTool(ctx, {
      Name: "list_installed_games",
      Description: "i18n:tool_list_installed_games",
      InputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional name filter." }
        },
        additionalProperties: false
      },
      OutputSchema: {
        type: "object",
        properties: {
          games: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                source: { type: "string" },
                appid: { type: "string" }
              },
              required: ["id", "name", "source", "appid"]
            }
          }
        },
        required: ["games"]
      },
      Annotations: { ReadOnly: true, Destructive: false, Idempotent: true, RequiresUI: false },
      Handler: async (_toolCtx, option) => this.handleList(option && option.Arguments)
    })
    await this.registerTool(ctx, {
      Name: "launch_game",
      Description: "i18n:tool_launch_game",
      InputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Installed game id, such as steam:570 or epic:AppName." },
          appid: { type: "string", description: "Launcher-specific app id, used when id is omitted." }
        },
        additionalProperties: false
      },
      OutputSchema: {
        type: "object",
        properties: { appid: { type: "string" } },
        required: ["appid"]
      },
      Annotations: { ReadOnly: false, Destructive: false, Idempotent: true, RequiresUI: false },
      Handler: async (toolCtx, option) => this.handleLaunch(option && option.Arguments, toolCtx)
    })
  }

  private async registerTool(
    ctx: Context,
    tool: {
      Name: string
      Description: string
      InputSchema: Record<string, unknown>
      OutputSchema: Record<string, unknown>
      Annotations: { ReadOnly: boolean; Destructive: boolean; Idempotent: boolean; RequiresUI: boolean }
      Handler: Parameters<PublicAPI["RegisterPluginTool"]>[1]["Handler"]
    }
  ): Promise<void> {
    if (!this.api) return
    try {
      const registered = await this.api.RegisterPluginTool(ctx, {
        Tool: {
          Name: tool.Name,
          Description: tool.Description,
          InputSchema: tool.InputSchema,
          OutputSchema: tool.OutputSchema,
          Annotations: tool.Annotations
        },
        Handler: tool.Handler
      })
      if (registered && registered.Error) {
        await this.log(ctx, "Warning", `${tool.Name} was not registered: ${registered.Error.Message || registered.Error.Code}`)
      }
    } catch (err) {
      await this.log(ctx, "Warning", `${tool.Name} unavailable: ${errorText(err)}`)
    }
  }

  private async handleList(args: Record<string, unknown> | undefined) {
    if (this.games.length === 0 && this.refreshing) await this.refreshing
    const matched = matchGames(this.games, String((args && args.query) || ""), { global: false })
    return {
      Output: {
        games: matched.map(({ game }) => ({
          id: game.id,
          name: game.name,
          source: game.source,
          appid: game.appid
        }))
      }
    }
  }

  private async handleLaunch(args: Record<string, unknown> | undefined, ctx: Context) {
    if (this.games.length === 0 && this.refreshing) await this.refreshing
    const id = String((args && args.id) || "").trim()
    const appid = String((args && args.appid) || "").trim()
    const game = this.byId.get(id) || (appid ? [...this.byId.values()].find(item => item.appid === appid) : undefined)
    if (!game) {
      await this.log(ctx, "Error", "launch_game_not_found", { id, appid, indexed: this.games.length, scanId: this.scanId })
      return { Error: { Code: "GAME_NOT_FOUND", Message: `No installed game for id ${id || appid}` } }
    }
    try {
      await this.launchGame(ctx, game)
    } catch (err) {
      return { Error: { Code: "LAUNCH_FAILED", Message: errorText(err) } }
    }
    return { Output: { appid: game.appid } }
  }
}

export const plugin = new GamesPlugin()
