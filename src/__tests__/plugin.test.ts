import { spawn, SpawnOptions } from "child_process"
import { EventEmitter } from "events"
import os from "os"
import { ActionContext, Context, PublicAPI, Query, SetSettingOption, WoxImage } from "@wox-launcher/wox-plugin"
import { GamesPlugin } from "../index"
import { openExternal } from "../launch"
import { createGame } from "../game"
import { InstalledGame, ScanDeps } from "../types"

const ctx = {} as Context
const actionContext = { ResultId: "1", ResultActionId: "launch", ContextData: {} } as ActionContext

function query(search: string, global: boolean): Query {
  return {
    Id: "1",
    Type: "input",
    RawQuery: search,
    Search: search,
    TriggerKeyword: global ? "" : "game",
    Command: "",
    Selection: { Type: "text", Text: "", FilePaths: [] },
    Env: {
      ActiveWindowTitle: "",
      ActiveWindowPid: 0,
      ActiveBrowserUrl: "",
      ActiveWindowIcon: { ImageType: "svg", ImageData: "" } as WoxImage
    },
    IsGlobalQuery: () => global
  }
}

function game(source: string, name: string, appid: string, extra: { storeUrl?: string } = {}): InstalledGame {
  const created = createGame(source, {
    appid,
    name,
    launchUrl: `${source}://${appid}`,
    installDir: `C:\\Games\\${name}`,
    storeUrl: extra.storeUrl
  })
  if (!created) throw new Error(name)
  return created
}

test("keyword search groups launchers and an empty global search stays quiet", async () => {
  const plugin = new GamesPlugin({
    games: [game("epic", "Control", "Control"), game("steam", "Dota 2", "570", { storeUrl: "https://store.steampowered.com/app/570" })],
    favorites: ["steam:570"]
  })
  const grouped = await plugin.query(ctx, query("", false))
  expect(grouped.Results.map(result => `${result.Group}:${result.Title}`)).toEqual(["Epic:Control", "i18n:group_favorites:Dota 2"])
  const favorite = grouped.Results[1]
  expect(favorite.SubTitle).toBe("Steam")
  expect(favorite.ScoreKey).toBe("steam:570")
  expect(favorite.GroupScore || 0).toBeGreaterThan(grouped.Results[0].GroupScore || 0)
  expect(grouped.Results[0].SubTitle).toBe("")
  expect(favorite.Actions?.map(action => action.Name)).toEqual(["i18n:action_launch", "i18n:action_unfavorite", "i18n:action_open_folder", "i18n:action_open_store", "i18n:action_copy_name"])

  const global = await plugin.query(ctx, query("", true))
  expect(global.Results).toEqual([])
  const matched = await plugin.query(ctx, query("control", true))
  expect(matched.Results.map(result => result.Title)).toEqual(["Control"])
  expect(matched.Results[0].Group).toBeUndefined()
})

function quietDeps(): ScanDeps {
  const missing = (file: string) => Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT", path: file })
  return {
    platform: "win32",
    homedir: "C:\\Users\\me",
    appData: "",
    publicDir: "",
    programData: "C:\\ProgramData",
    programFiles: "C:\\Program Files",
    programFilesX86: "C:\\Program Files (x86)",
    exists: async () => false,
    readFile: async file => {
      throw missing(file)
    },
    readdir: async dir => {
      throw missing(dir)
    },
    regQuery: async () => "",
    regQueryTree: async () => "",
    windowsInventory: async () => ({ apps: [], drives: [], errors: [] })
  }
}

test("favorite action saves the newest id first and asks Wox to refresh", async () => {
  const saved: string[] = []
  let refreshed = false
  const dota = game("steam", "Dota 2", "570")
  const plugin = new GamesPlugin({
    games: [dota],
    deps: quietDeps(),
    launchers: [{ id: "steam", label: "Steam", scan: async () => ({ games: [dota], watchDirs: [] }) }]
  })
  await plugin.init(ctx, {
    PluginDirectory: "",
    API: {
      Log: async () => undefined,
      GetCacheFolder: async () => "",
      GetSetting: async () => "[]",
      OnSettingChanged: async () => undefined,
      OnMRURestore: async () => undefined,
      OnUnload: async () => undefined,
      RegisterPluginTool: async () => ({}),
      SetSetting: async (_ctx: Context, option: SetSettingOption) => {
        saved.push(option.Value)
        return { Success: true, ErrMsg: "" }
      },
      RefreshQuery: async () => {
        refreshed = true
      },
      GetTranslation: async () => "failed",
      Notify: async () => undefined,
      Copy: async () => undefined
    } as unknown as PublicAPI
  })
  await plugin.refresh()
  plugin.stop()
  const listed = await plugin.query(ctx, query("", false))
  const favorite = listed.Results[0].Actions?.find(action => action.Name === "i18n:action_favorite")
  if (!favorite || !("Action" in favorite)) throw new Error("missing favorite action")
  await favorite.Action(ctx, actionContext)
  expect(saved).toEqual(['["steam:570"]'])
  expect(refreshed).toBe(true)
  expect(plugin.restoreResult({ id: "steam:570" })?.Tails?.[0]?.Tooltip).toBe("i18n:group_favorites")
  expect(plugin.restoreResult({ id: "missing" })).toBeNull()
})

test("launch rejects an empty target and an installation directory", async () => {
  await expect(openExternal("", [])).rejects.toThrow(/empty/)
  await expect(openExternal(os.tmpdir(), [], { isLaunch: true, platform: "win32" })).rejects.toThrow(/directory/)
})

test("windows protocol launch goes through cmd start", async () => {
  const epic = "com.epicgames.launcher://apps/ns%3Acat%3Aapp?action=launch&silent=true"
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []
  const spawnImpl = ((command: string, args: readonly string[], options: SpawnOptions) => {
    calls.push({ command, args, options })
    const child = new EventEmitter() as EventEmitter & { pid: number; stderr: EventEmitter; unref: () => void; kill: () => boolean }
    child.pid = 42
    child.stderr = new EventEmitter()
    child.unref = () => undefined
    child.kill = () => true
    process.nextTick(() => {
      child.emit("spawn")
      child.emit("close", 0, null)
    })
    return child
  }) as unknown as typeof spawn
  const result = await openExternal(epic, [], {
    platform: "win32",
    spawn: spawnImpl,
    regQueryTree: async () => "HKEY_CLASSES_ROOT\\com.epicgames.launcher\\shell\\open\\command\r\n    (Default)    REG_SZ    epic.exe"
  })
  expect(result.method).toBe("protocol")
  expect(calls).toHaveLength(1)
  expect(calls[0].command).toMatch(/[\\/]cmd\.exe$/)
  expect(calls[0].args).toEqual(["/c", "start", "", "com.epicgames.launcher://apps/ns%3Acat%3Aapp?action=launch^&silent=true"])
  expect(calls[0].options.stdio).toBe("ignore")
  expect(calls[0].options.detached).toBe(true)
  expect(calls[0].options.windowsVerbatimArguments).toBeFalsy()
  await openExternal("steam://rungameid/570", [], { platform: "win32", spawn: spawnImpl, regQueryTree: async () => "registered" })
  expect(calls[1].args).toEqual(["/c", "start", "", "steam://rungameid/570"])
  await openExternal("Foo & Bar", [], { platform: "win32", spawn: spawnImpl })
  expect(calls[2].args[3]).toBe("Foo & Bar")
  await expect(openExternal("missingproto://game", [], { platform: "win32", spawn: spawnImpl, regQueryTree: async () => "" })).rejects.toMatchObject({ code: "EPROTONOSUPPORT" })
  expect(calls).toHaveLength(3)
})
