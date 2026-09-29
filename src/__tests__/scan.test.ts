import path from "path"
import { EaLauncher } from "../launchers/ea"
import { SteamLauncher } from "../launchers/steam"
import { XboxLauncher } from "../launchers/xbox"
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

test("xbox scan uses the packaged logo when the executable has no shell icon", async () => {
  const install = "C:\\Program Files\\WindowsApps\\Microsoft.4297127D64EC6_2.6.2.0_x64__8wekyb3d8bbwe"
  const config = path.win32.join(install, "MicrosoftGame.config")
  const xml =
    '<Game><Identity Name="Microsoft.4297127D64EC6" /><ExecutableList><Executable Name="Minecraft.exe" TargetDeviceFamily="PC" /></ExecutableList><ShellVisuals DefaultDisplayName="Minecraft Launcher" Square150x150Logo="GraphicsLogo.png" Square44x44Logo="SmallLogo.png" StoreLogo="StoreLogo.png" SplashScreenImage="SplashScreen.png" /></Game>'
  const deps = memoryDeps(
    {
      [config]: xml,
      [path.win32.join(install, "SmallLogo.scale-200.png")]: "png",
      [path.win32.join(install, "GraphicsLogo.png")]: "png",
      [path.win32.join(install, "Minecraft.exe")]: "exe"
    },
    { "C:\\XboxGames": ["GameSave"] }
  )
  deps.windowsInventory = async () => ({
    apps: [{ name: "Minecraft Launcher", appid: "Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft", family: "Microsoft.4297127D64EC6_8wekyb3d8bbwe", installDir: install }],
    drives: ["C:\\"],
    errors: []
  })
  const found = await new XboxLauncher().scan(deps)
  expect(found.games.map(game => game.name)).toEqual(["Minecraft Launcher"])
  expect(found.games[0].launchUrl).toBe("shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft")
  expect(found.games[0].iconPath).toBe(path.win32.join(install, "SmallLogo.scale-200.png"))
  expect(found.games[0].iconType).toBe("absolute")
})

test("xbox scan keeps the executable icon when no logo file exists", async () => {
  const install = "D:\\XboxGames\\Halo\\Content"
  const config = path.win32.join(install, "MicrosoftGame.config")
  const xml = '<Game><Identity Name="Microsoft.Halo" /><Executable Name="game.exe" Id="App" /><ShellVisuals DefaultDisplayName="Halo" Square44x44Logo="SmallLogo.png" /></Game>'
  const deps = memoryDeps({ [config]: xml, [path.win32.join(install, "game.exe")]: "exe" }, { "D:\\XboxGames": ["Halo"] })
  deps.windowsInventory = async () => ({ apps: [{ appid: "Microsoft.Halo_abc!App", installDir: install }], drives: ["D:\\"], errors: [] })
  const found = await new XboxLauncher().scan(deps)
  expect(found.games[0].iconPath).toBe(path.win32.join(install, "game.exe"))
  expect(found.games[0].iconType).toBe("fileicon")
})

test("ea scan uses the manifest registry token when several executables are present", async () => {
  const install = "D:\\EA\\SWGoH"
  const manifest = path.win32.join(install, "__Installer", "installerdata.xml")
  const exe = path.win32.join(install, "SWGoH.exe")
  const xml =
    '<DiPManifest><touchup><filePath>/__Installer/touchup.exe</filePath></touchup><contentIDs><contentID>195217</contentID></contentIDs><gameTitles><gameTitle locale="en_US">Star Wars: Galaxy of Heroes</gameTitle></gameTitles><runtime><launcher><filePath>[HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\SWGoH\\Install Dir]SWGoH.exe</filePath></launcher></runtime></DiPManifest>'
  const deps = memoryDeps(
    { [manifest]: xml, [exe]: "exe", [path.win32.join(install, "Helper.exe")]: "exe" },
    { [install]: ["SWGoH.exe", "Helper.exe", "UnityCrashHandler64.exe"] },
    { "HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\SWGoH|Install Dir": "D:\\EA\\SWGoH\\" }
  )
  deps.regQueryTree = async key =>
    key.endsWith("\\EA Games")
      ? "HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\SWGoH\r\n    DisplayName    REG_SZ    Star Wars: Galaxy of Heroes\r\n    Install Dir    REG_SZ    D:\\EA\\SWGoH\\\r\n\r\n"
      : ""
  const found = await new EaLauncher().scan(deps)
  expect(found.games.map(game => game.name)).toEqual(["Star Wars: Galaxy of Heroes"])
  expect(found.games[0].iconPath).toBe(exe)
  expect(found.games[0].iconType).toBe("fileicon")
  expect(found.games[0].launchUrl).toBe("origin2://game/launch?offerIds=195217")
})

test("ea scan keeps an uninstall display icon when the manifest executable is missing", async () => {
  const install = "D:\\Game"
  const manifest = path.win32.join(install, "__Installer", "installerdata.xml")
  const exe = path.win32.join(install, "Game.exe")
  const xml = "<gameTitle>Medal</gameTitle><contentID>9</contentID><runtime><launcher><filePath>[HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\Game\\Install Dir]missing.exe</filePath></launcher></runtime>"
  const deps = memoryDeps(
    { [manifest]: xml, [exe]: "exe", [path.win32.join(install, "Launcher.exe")]: "exe" },
    { [install]: ["Game.exe", "Launcher.exe"] },
    { "HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\Game|Install Dir": "D:\\Game\\" }
  )
  deps.regQueryTree = async key => {
    if (key.endsWith("\\EA Games")) return "HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\Game\r\n    DisplayName    REG_SZ    Medal\r\n    Install Dir    REG_SZ    D:\\Game\\\r\n\r\n"
    if (key.endsWith("\\Uninstall"))
      return 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}\r\n    DisplayName    REG_SZ    Medal\r\n    Publisher    REG_SZ    Electronic Arts\r\n    InstallLocation    REG_SZ    D:\\Game\\\r\n    DisplayIcon    REG_SZ    "D:\\Game\\Game.exe"\r\n\r\n'
    return ""
  }
  const found = await new EaLauncher().scan(deps)
  expect(found.games).toHaveLength(1)
  expect(found.games[0].iconPath).toBe(exe)
  expect(found.games[0].iconType).toBe("fileicon")
  expect(found.games[0].launchUrl).toBe("origin2://game/launch?offerIds=9")
})

test("ea scan uses the game executable instead of the anticheat launcher icon", async () => {
  const install = "D:\\EA\\Skate"
  const manifest = path.win32.join(install, "__Installer", "installerdata.xml")
  const exe = path.win32.join(install, "Skate.exe")
  const anticheat = path.win32.join(install, "EAAnticheat.GameServiceLauncher.exe")
  const xml =
    "<gameTitle>skate.</gameTitle><contentID>1184493</contentID><runtime><launcher><filePath>[HKEY_LOCAL_MACHINE\\SOFTWARE\\Full Circle\\Skate\\Install Dir]EAAnticheat.GameServiceLauncher.exe</filePath></launcher></runtime>"
  const deps = memoryDeps(
    { [manifest]: xml, [exe]: "exe", [anticheat]: "exe" },
    { [install]: ["Skate.exe", "EAAnticheat.GameServiceLauncher.exe"] },
    { "HKEY_LOCAL_MACHINE\\SOFTWARE\\Full Circle\\Skate|Install Dir": "D:\\EA\\Skate\\" }
  )
  deps.regQueryTree = async key =>
    key.endsWith("\\Uninstall")
      ? 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}\r\n    DisplayName    REG_SZ    skate.\r\n    Publisher    REG_SZ    Electronic Arts\r\n    InstallLocation    REG_SZ    D:\\EA\\Skate\\\r\n    DisplayIcon    REG_SZ    "D:\\EA\\Skate\\Skate.exe"\r\n\r\n'
      : ""
  const found = await new EaLauncher().scan(deps)
  expect(found.games.map(game => game.name)).toEqual(["skate."])
  expect(found.games[0].iconPath).toBe(exe)
  expect(found.games[0].iconType).toBe("fileicon")
  expect(found.games[0].launchUrl).toBe("origin2://game/launch?offerIds=1184493")
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
