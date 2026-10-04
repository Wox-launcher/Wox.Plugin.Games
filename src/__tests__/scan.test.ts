import path from "path"
import { encodePng, pngFromIco } from "../ico"
import { EaLauncher } from "../launchers/ea"
import { pickIcon, SteamLauncher } from "../launchers/steam"
import { UbisoftLauncher } from "../launchers/ubisoft"
import { XboxLauncher } from "../launchers/xbox"
import { EpicLauncher } from "../launchers/epic"
import { GogLauncher } from "../launchers/gog"
import { BattleNetLauncher } from "../launchers/battlenet"
import { scanAll, traceScanDeps } from "../scan"
import { createGame } from "../game"
import { GameLauncher, ScanDeps } from "../types"

function memoryDeps(files: Record<string, string>, dirs: Record<string, string[]>, reg: Record<string, string> = {}): ScanDeps {
  const missing = (file: string) => Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT", path: file })
  const binary = new Map<string, Buffer>()
  return {
    platform: "win32",
    homedir: "C:\\Users\\me",
    appData: "C:\\Users\\me\\AppData\\Roaming",
    publicDir: "C:\\Users\\Public",
    programData: "C:\\ProgramData",
    programFiles: "C:\\Program Files",
    programFilesX86: "C:\\Program Files (x86)",
    exists: async file => binary.has(file) || Object.prototype.hasOwnProperty.call(files, file) || Object.prototype.hasOwnProperty.call(dirs, file),
    cacheDir: "C:\\cache",
    fileVersion: async () => "100:1",
    readBinary: async file => {
      const data = binary.get(file)
      if (!data) throw missing(file)
      return data
    },
    writeBinary: async (file, data) => {
      binary.set(file, data)
    },
    extractWindowsIcon: jest.fn(async () => encodePng(1, 1, Buffer.from([255, 0, 0, 255]))),
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
  const icon = path.win32.join(steam, "appcache", "librarycache", "570_icon.jpg")
  const deps = memoryDeps(
    {
      [icon]: "jpg",
      [path.win32.join(steamapps, "libraryfolders.vdf")]: `"libraryfolders"\n{\n"0"\n{\n"path" "C:\\\\Steam"\n}\n}\n`,
      [path.win32.join(steamapps, "appmanifest_570.acf")]: `"AppState" { "appid" "570" "name" "Dota 2" "installdir" "dota 2 beta" "StateFlags" "4" }`
    },
    { [steamapps]: ["libraryfolders.vdf", "appmanifest_570.acf"] },
    { "HKCU\\Software\\Valve\\Steam|SteamPath": steam }
  )
  const found = await new SteamLauncher().scan(deps)
  expect(found.games.map(game => game.id)).toEqual(["steam:570"])
  expect(found.games[0].installDir).toBe(path.win32.join(steam, "steamapps", "common", "dota 2 beta"))
  expect(found.games[0].iconPath).toBe(icon)
  expect(found.games[0].iconType).toBe("absolute")
  expect(found.games[0].launchUrl).toBe("steam://rungameid/570")
  expect(found.watchDirs).toContain(steamapps)
})

const iconHash = "a".repeat(40)
test.each<[string, string[], string[] | null, string]>([
  ["legacy icon", ["../1_icon.jpg", `${iconHash}.jpg`, "logo.png"], [`${iconHash}.jpg`, "logo.png"], "../1_icon.jpg"],
  ["current icon", [`${iconHash}.JPG`, "logo.png"], ["header.jpg", `${iconHash}.JPG`, "logo.png"], `${iconHash}.JPG`],
  ["remaining icon after a cache change", [`${"b".repeat(40)}.jpg`, "logo.png"], [`${"b".repeat(40)}.jpg`, `${iconHash}.jpg`], `${"b".repeat(40)}.jpg`],
  ["logo after all game icons disappear", ["logo.png"], [`${iconHash}.jpg`, "logo.png"], "logo.png"],
  ["direct logo with unreadable directory", ["logo.png"], null, "logo.png"],
  ["localized nested logo", ["hash/logo_schinese.png"], ["header.jpg", "hash"], "hash/logo_schinese.png"],
  ["no artwork", [], [], ""]
])("Steam chooses %s and preserves logo fallbacks", async (_label, files, entries, expected) => {
  const cache = path.win32.join("C:\\Steam", "appcache", "librarycache", "1")
  const deps = memoryDeps(
    Object.fromEntries(files.map(file => [path.win32.join(cache, file), "image"])),
    entries === null ? {} : { [cache]: entries, [path.win32.join(cache, "hash")]: ["logo_schinese.png"] }
  )
  expect(await pickIcon("C:\\Steam", "1", deps)).toBe(expected ? path.win32.join(cache, expected) : "")
})

test("Steam falls back to its logo and reports an inaccessible game icon", async () => {
  const cache = path.win32.join("C:\\Steam", "appcache", "librarycache", "1")
  const icon = path.win32.join(cache, `${iconHash}.jpg`)
  const logo = path.win32.join(cache, "logo.png")
  const deps = memoryDeps({ [logo]: "png" }, { [cache]: [`${iconHash}.jpg`, "logo.png"] })
  const exists = deps.exists
  deps.exists = async file => {
    if (file === icon) throw Object.assign(new Error("Access denied"), { code: "EACCES", path: file })
    return exists(file)
  }
  const report = jest.fn()
  expect(await pickIcon("C:\\Steam", "1", traceScanDeps(deps, report))).toBe(logo)
  expect(report).toHaveBeenCalledWith("scan_io_failed", expect.objectContaining({ operation: "exists", errorCode: "EACCES", path: icon }), "Warning")
})

test("Steam ignores unrelated JPG artwork when no game icon is cached", async () => {
  const cache = "C:\\Steam\\appcache\\librarycache\\1"
  const names = ["header.jpg", "library_600x900.jpg", "icon.jpg", `${iconHash.slice(1)}.jpg`, "../other-game.jpg"]
  const deps = memoryDeps(Object.fromEntries(names.map(name => [path.win32.join(cache, name), "jpg"])), { [cache]: names })
  expect(await pickIcon("C:\\Steam", "1", deps)).toBe("")
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
  expect(deps.extractWindowsIcon).toHaveBeenCalledWith(exe)
  expect(found.games[0].iconPath).toMatch(/\\icons\\[a-f0-9]{64}\.png$/)
  expect(found.games[0].iconType).toBe("absolute")
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
  expect(deps.extractWindowsIcon).toHaveBeenCalledWith(exe)
  expect(found.games[0].iconPath).toMatch(/\\icons\\[a-f0-9]{64}\.png$/)
  expect(found.games[0].iconType).toBe("absolute")
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
  expect(deps.extractWindowsIcon).toHaveBeenCalledWith(exe)
  expect(deps.extractWindowsIcon).not.toHaveBeenCalledWith(anticheat)
  expect(found.games[0].iconPath).toMatch(/\\icons\\[a-f0-9]{64}\.png$/)
  expect(found.games[0].iconType).toBe("absolute")
  expect(found.games[0].launchUrl).toBe("origin2://game/launch?offerIds=1184493")
})

test("ubisoft scan uses the launcher data icon when the install folder has no executable", async () => {
  const icon = path.win32.join("C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\data", "cead53fb4a7ffdd39d2a1bafb50dff98.ico")
  const config = path.win32.join("C:\\Users\\me\\AppData\\Local", "Ubisoft Game Launcher", "cache", "configuration", "configurations")
  const text = [
    "version: 2.0",
    "root:",
    "  name: Growtopia",
    "  icon_image: cead53fb4a7ffdd39d2a1bafb50dff98.ico",
    "        working_directory:",
    "          register: HKEY_LOCAL_MACHINE\\SOFTWARE\\Ubisoft\\Launcher\\Installs\\924\\InstallDir"
  ].join("\r\n")
  const ico = Buffer.alloc(70)
  ico.writeUInt16LE(1, 2)
  ico.writeUInt16LE(1, 4)
  ico[6] = 1
  ico[7] = 1
  ico.writeUInt16LE(1, 10)
  ico.writeUInt16LE(24, 12)
  ico.writeUInt32LE(48, 14)
  ico.writeUInt32LE(22, 18)
  ico.writeUInt32LE(40, 22)
  ico.writeInt32LE(1, 26)
  ico.writeInt32LE(2, 30)
  ico.writeUInt16LE(1, 34)
  ico.writeUInt16LE(24, 36)
  ico[64] = 255
  const png = pngFromIco(ico)
  if (!png) throw new Error("png")
  let saved = ""
  const deps = memoryDeps({ [config]: text, [icon]: "ico" }, {}, { "HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher|InstallDir": "C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\" })
  deps.cacheDir = "C:\\cache"
  deps.readBinary = async () => ico
  deps.writeBinary = async (file, data) => {
    saved = file
    expect(file).toMatch(/\\icons\\[a-f0-9]{64}\.png$/)
    expect(data.equals(png)).toBe(true)
  }
  deps.regQueryTree = async key =>
    key.endsWith("\\WOW6432Node\\Ubisoft\\Launcher\\Installs")
      ? "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs\\924\r\n    InstallDir    REG_SZ    C:/Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games/Growtopia/\r\n\r\n"
      : ""
  const found = await new UbisoftLauncher().scan(deps)
  expect(found.games.map(game => game.name)).toEqual(["Growtopia"])
  expect(found.games[0].iconType).toBe("absolute")
  expect(found.games[0].iconPath).toBe(saved)
  expect(deps.extractWindowsIcon).not.toHaveBeenCalled()
  expect(found.games[0].launchUrl).toBe("uplay://launch/924")
})

test("ubisoft scan keeps the game executable when the cached icon is missing", async () => {
  const install = "D:\\Games\\Anno"
  const exe = path.win32.join(install, "Anno.exe")
  const config = path.win32.join("C:\\Users\\me\\AppData\\Local", "Ubisoft Game Launcher", "cache", "configuration", "configurations")
  const deps = memoryDeps(
    {
      [config]: "version: 2.0\r\nicon_image: missing.ico\r\nregister: HKEY_LOCAL_MACHINE\\SOFTWARE\\Ubisoft\\Launcher\\Installs\\123\\InstallDir\r\n",
      [exe]: "exe"
    },
    { [`${install}\\`]: ["Anno.exe", "unins000.exe"] },
    { "HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher|InstallDir": "C:\\Ubisoft\\Ubisoft Game Launcher\\" }
  )
  deps.regQueryTree = async key =>
    key.endsWith("\\WOW6432Node\\Ubisoft\\Launcher\\Installs")
      ? "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs\\123\r\n    InstallDir    REG_SZ    D:\\Games\\Anno\\\r\n\r\n"
      : ""
  const found = await new UbisoftLauncher().scan(deps)
  expect(deps.extractWindowsIcon).toHaveBeenCalledWith(exe)
  expect(found.games[0].iconPath).toMatch(/\\icons\\[a-f0-9]{64}\.png$/)
  expect(found.games[0].iconType).toBe("absolute")
})

test("Ubisoft matches a legacy GameUpdate registry reference to the installed directory", async () => {
  const config = "C:\\Users\\me\\AppData\\Local\\Ubisoft Game Launcher\\cache\\configuration\\configurations"
  const install = "C:/Games/Assassin's Creed II/"
  const icon = "C:\\Ubisoft\\data\\ac2.png"
  const deps = memoryDeps(
    {
      [config]: `version: 2.0\nroot:\n  name: Localized title\n  icon_image: ac2.png\n  start_game:\n    online:\n      executables:\n        - path:\n            relative: AssassinsCreedIIGame.exe\n          working_directory:\n            register: HKEY_LOCAL_MACHINE\\SOFTWARE\\Ubisoft\\Assassin's Creed II\\GameUpdate\\installdir\n`,
      [icon]: "png"
    },
    { [install]: ["AssassinsCreedII.exe", "AssassinsCreedIIGame.exe", "UPlayBrowser.exe"] },
    {
      "HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher|InstallDir": "C:\\Ubisoft"
    }
  )
  deps.regQueryTree = async key => {
    if (key.endsWith("\\Launcher\\Installs")) return `HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs\\4\r\n    InstallDir    REG_SZ    ${install}\r\n\r\n`
    if (key === "HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft")
      return `HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Assassin's Creed II\\GameUpdate\r\n    installdir    REG_SZ    c:\\Games\\Assassin's Creed II\r\n\r\n`
    return ""
  }
  const found = await new UbisoftLauncher().scan(deps)
  expect(found.games).toHaveLength(1)
  expect(found.games[0].iconPath).toBe(icon)
  expect(found.games[0].iconType).toBe("absolute")
  expect(found.games[0].launchUrl).toBe("uplay://launch/4")
})

test("epic keeps games and launch URLs when Windows extraction fails", async () => {
  const dir = path.win32.join("C:\\ProgramData", "Epic", "EpicGamesLauncher", "Data", "Manifests")
  const exe = "D:\\Epic\\Game\\Game.exe"
  const deps = memoryDeps(
    {
      [path.win32.join(dir, "game.item")]: JSON.stringify({
        DisplayName: "Game",
        AppName: "game",
        CatalogNamespace: "ns",
        CatalogItemId: "item",
        InstallLocation: "D:\\Epic\\Game",
        LaunchExecutable: "Game.exe"
      }),
      [exe]: "exe"
    },
    { [dir]: ["game.item"] }
  )
  deps.extractWindowsIcon = jest.fn(async () => {
    throw new Error("unsupported resource")
  })
  const found = await new EpicLauncher().scan(deps)
  expect(found.games).toHaveLength(1)
  expect(found.games[0].launchUrl).toBe("com.epicgames.launcher://apps/ns%3Aitem%3Agame?action=launch&silent=true")
  expect(found.games[0].iconPath).toBe("")
  expect(found.games[0].iconType).toBe("")
})

test("GOG materializes icons without changing the executable launch target", async () => {
  const exe = "D:\\GOG\\Game\\Game.exe"
  const deps = memoryDeps({ [exe]: "exe" }, {})
  deps.regQueryTree = async () => `HKEY_LOCAL_MACHINE\\SOFTWARE\\GOG.com\\Games\\123\r\n    gameName    REG_SZ    Game\r\n    path    REG_SZ    D:\\GOG\\Game\r\n    exe    REG_SZ    Game.exe\r\n\r\n`
  const found = await new GogLauncher().scan(deps)
  expect(found.games).toHaveLength(1)
  expect(found.games[0].launchUrl).toBe(exe)
  expect(found.games[0].iconType).toBe("absolute")
  expect(found.games[0].iconPath).not.toBe(exe)
  expect(deps.extractWindowsIcon).toHaveBeenCalledTimes(1)
})

test.each(["aggregate", "registry"])("Battle.net converts %s icons and keeps launch arguments", async source => {
  const client = "C:\\Program Files (x86)\\Battle.net\\Battle.net.exe"
  const icon = "D:\\Blizzard\\Diablo\\Diablo.exe"
  const catalog = "C:\\ProgramData\\Battle.net\\Agent\\aggregate.json"
  const files: Record<string, string> = { [client]: "exe", [icon]: "exe" }
  if (source === "aggregate") files[catalog] = JSON.stringify({ installed: [{ name: "Diablo III", product_id: "d3", icon_path: icon }] })
  const deps = memoryDeps(files, {})
  deps.regQueryTree = async () =>
    `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Diablo\r\n    DisplayName    REG_SZ    Diablo III\r\n    UninstallString    REG_SZ    Battle.net.exe --uid=d3\r\n    InstallLocation    REG_SZ    D:\\Blizzard\\Diablo\r\n    DisplayIcon    REG_SZ    "${icon}",0\r\n\r\n`
  const found = await new BattleNetLauncher().scan(deps)
  expect(found.games).toHaveLength(1)
  expect(found.games[0].launchUrl).toBe(client)
  expect(found.games[0].launchArgs).toEqual(["--exec=launch D3"])
  expect(found.games[0].iconType).toBe("absolute")
  expect(deps.extractWindowsIcon).toHaveBeenCalledWith(icon)
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
