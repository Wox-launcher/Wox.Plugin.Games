import path from "path"
import { SteamLauncher } from "../launchers/steam"
import { scanAll } from "../scan"
import { createGame } from "../game"
import { GameLauncher, ScanDeps } from "../types"

function memoryDeps(files: Record<string, string>, dirs: Record<string, string[]>, reg: Record<string, string> = {}): ScanDeps {
  const missing = (file: string) => Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT", path: file })
  return {
    platform: "win32",
    homedir: "C:\\Users\\me",
    appData: "C:\\Users\\me\\AppData\\Roaming",
    publicDir: "C:\\Users\\Public",
    programData: "C:\\ProgramData",
    programFiles: "C:\\Program Files",
    programFilesX86: "C:\\Program Files (x86)",
    exists: async file => Object.prototype.hasOwnProperty.call(files, file) || Object.prototype.hasOwnProperty.call(dirs, file),
    readFile: async file => {
      if (!Object.prototype.hasOwnProperty.call(files, file)) throw missing(file)
      return files[file]
    },
    readdir: async dir => {
      if (!Object.prototype.hasOwnProperty.call(dirs, dir)) throw missing(dir)
      return dirs[dir]
    },
    regQuery: async (key, name) => reg[`${key}|${name}`] || "",
    regQueryTree: async () => "",
    windowsInventory: async () => ({ apps: [], drives: [], errors: [] })
  }
}

test("steam launcher reads manifests from libraryfolders.vdf", async () => {
  const steam = "C:\\Steam"
  const steamapps = path.win32.join(steam, "steamapps")
  const deps = memoryDeps(
    {
      [path.win32.join(steamapps, "libraryfolders.vdf")]: `"libraryfolders"\n{\n"0"\n{\n"path" "C:\\\\Steam"\n}\n}\n`,
      [path.win32.join(steamapps, "appmanifest_570.acf")]: `"AppState" { "appid" "570" "name" "Dota 2" "installdir" "dota 2 beta" "StateFlags" "4" }`
    },
    { [steamapps]: ["libraryfolders.vdf", "appmanifest_570.acf"] },
    { "HKCU\\Software\\Valve\\Steam|SteamPath": steam }
  )
  const found = await new SteamLauncher().scan(deps)
  expect(found.games.map(game => game.id)).toEqual(["steam:570"])
  expect(found.games[0].installDir).toBe(path.win32.join(steam, "steamapps", "common", "dota 2 beta"))
  expect(found.watchDirs).toContain(steamapps)
})

test("one launcher failure does not drop games from the others", async () => {
  const game = createGame("steam", { appid: "570", name: "Dota 2", launchUrl: "steam://rungameid/570" })
  if (!game) throw new Error("game")
  const launchers: GameLauncher[] = [
    {
      id: "epic",
      label: "Epic",
      scan: async () => {
        throw new Error("epic unavailable")
      }
    },
    {
      id: "steam",
      label: "Steam",
      scan: async () => ({ games: [game], watchDirs: ["C:\\Steam\\steamapps", "C:\\Steam\\steamapps"] })
    }
  ]
  const deps = memoryDeps({}, {})
  const found = await scanAll(deps, launchers)
  expect(found.games.map(item => item.id)).toEqual(["steam:570"])
  expect(found.watchDirs).toEqual(["C:\\Steam\\steamapps"])
  expect(found.scanId).toMatch(/[0-9a-f-]{36}/)
})
