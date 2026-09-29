import path from "path"
import { battleNetGamesFromAggregate, battleNetGamesFromReg, launchBattleNetGame, parseBattleNetLaunchCode, parseBattleNetSnapshot } from "../launchers/battlenet"
import { eaGameFromInstallerXml, eaGamesFromReg, launchEaGame, parseEaSnapshot, resolveEaFilePath } from "../launchers/ea"
import { epicGameFromManifest } from "../launchers/epic"
import { gogGamesFromReg } from "../launchers/gog"
import { itchExecutable } from "../launchers/itch"
import { gameFromManifest, iconFromUrlShortcut, isRuntimeName, libraryPaths, parseVdf } from "../launchers/steam"
import { ubisoftGamesFromReg } from "../launchers/ubisoft"
import { xboxGameFromConfig, xboxIconCandidates } from "../launchers/xbox"
import { matchGames, scoreName } from "../match"
import { displayIconPath, parseRegSz, parseRegTree } from "../registry"
import { decodeXmlText } from "../xml"
import { createGame, parseFavorites } from "../game"
import { InstalledGame } from "../types"

function mustGame(source: string, name: string, appid = "1"): InstalledGame {
  const game = createGame(source, { appid, name, launchUrl: `${source}://${appid}`, installDir: `C:\\Games\\${name}` })
  if (!game) throw new Error(`invalid ${name}`)
  return game
}

test("parseVdf reads library folders and skips comments", () => {
  const root = parseVdf(`
    // ignored
    "libraryfolders"
    {
      "0" { "path" "C:\\\\Steam" }
      "1" "D:\\\\Games"
    }
  `)
  expect(libraryPaths(root)).toEqual(["C:\\Steam", "D:\\Games"])
})

test("gameFromManifest keeps fully installed games and drops runtimes", () => {
  const installed = gameFromManifest(parseVdf(`"AppState" { "appid" "570" "name" "Dota 2" "installdir" "dota 2 beta" "StateFlags" "4" }`), "C:\\Steam", "C:\\Steam")
  expect(installed?.id).toBe("steam:570")
  expect(installed?.installDir).toBe(path.join("C:\\Steam", "steamapps", "common", "dota 2 beta"))
  expect(installed?.launchUrl).toBe("steam://rungameid/570")
  expect(gameFromManifest(parseVdf(`"AppState" { "appid" "1" "name" "Pending" "StateFlags" "2" }`), "C:\\Steam", "C:\\Steam")).toBeNull()
  expect(isRuntimeName("Proton 9.0")).toBe(true)
  expect(gameFromManifest(parseVdf(`"AppState" { "appid" "9" "name" "Proton 9.0" "StateFlags" "4" }`), "C:\\Steam", "C:\\Steam")).toBeNull()
})

test("iconFromUrlShortcut reads a Steam desktop shortcut", () => {
  expect(iconFromUrlShortcut(`[InternetShortcut]\r\nURL=steam://rungameid/570\r\nIconFile="C:\\Icons\\dota.ico"\r\n`)).toEqual({
    appid: "570",
    iconPath: "C:\\Icons\\dota.ico"
  })
})

test("matchGames ranks names and hides an empty global query", () => {
  const games = [mustGame("steam", "Dota 2", "570"), mustGame("epic", "Control", "Control"), mustGame("gog", "Hades", "1207659013")]
  expect(matchGames(games, "", { global: true })).toEqual([])
  expect(matchGames(games, "").map(item => item.game.name)).toEqual(["Control", "Dota 2", "Hades"])
  expect(scoreName("Dota 2", "dota")).toBe(800)
  expect(matchGames(games, "dt", { global: true }).map(item => item.game.name)).toEqual(["Dota 2"])
  expect(matchGames(games, "z")).toEqual([])
})

test("epic manifest requires a complete game identity", () => {
  const game = epicGameFromManifest({
    DisplayName: "Fortnite",
    AppName: "Fortnite",
    CatalogNamespace: "fn",
    CatalogItemId: "catalog",
    InstallLocation: "D:\\Fortnite",
    LaunchExecutable: "Fortnite.exe",
    AppCategories: ["games"]
  })
  expect(game?.id).toBe("epic:Fortnite")
  expect(game?.launchUrl).toContain("fn%3Acatalog%3AFortnite")
  expect(game?.iconPath).toBe(path.join("D:\\Fortnite", "Fortnite.exe"))
  expect(epicGameFromManifest({ DisplayName: "Tool", AppName: "Tool", CatalogNamespace: "ns", CatalogItemId: "id", AppCategories: ["apps"] })).toBeNull()
})

test("gog and ubisoft registry rows become games", () => {
  const gog = gogGamesFromReg([
    { key: "HKEY_LOCAL_MACHINE\\SOFTWARE\\GOG.com\\Games\\1207659013", values: { gameName: "Hades", path: "D:\\Hades", exe: "Hades.exe" } },
    { key: "HKEY_LOCAL_MACHINE\\SOFTWARE\\GOG.com\\Games\\999", values: { gameName: "Soundtrack", path: "D:\\Hades", dependsOn: "1207659013" } }
  ])
  expect(gog.map(game => game.name)).toEqual(["Hades"])
  expect(gog[0].launchUrl).toBe(path.join("D:\\Hades", "Hades.exe"))

  const ubisoft = ubisoftGamesFromReg([{ key: "HKEY_LOCAL_MACHINE\\SOFTWARE\\Ubisoft\\Launcher\\Installs\\123", values: { InstallDir: "D:\\Games\\Anno\\" } }])
  expect(ubisoft[0]).toMatchObject({ id: "ubisoft:123", name: "Anno", launchUrl: "uplay://launch/123" })
})

test("ea installer xml decodes entities and keeps content ids", () => {
  const xml = "<gameTitle>Dragon Age&#8482;</gameTitle><contentID>ofb1</contentID><contentID>ofb1</contentID><filePath>[INSTALLDIR]\\Game.exe</filePath>"
  const game = eaGameFromInstallerXml(xml, "D:\\Dragon Age")
  expect(decodeXmlText("Dragon Age&#8482;")).toBe("Dragon Age™")
  expect(game?.name).toBe("Dragon Age™")
  expect(game?.offerIds).toEqual(["ofb1"])
  expect(game?.launchUrl).toBe("origin2://game/launch?offerIds=ofb1")
  expect(game?.iconPath).toBe(path.join("D:\\Dragon Age", "Game.exe"))
  const fromReg = eaGamesFromReg([{ key: "HKEY_LOCAL_MACHINE\\SOFTWARE\\Origin Games\\123", values: { DisplayName: "Origin Game", "Install Dir": "D:\\Origin Game" } }])
  expect(fromReg[0].launchUrl).toBe("origin2://game/launch?offerIds=123")
  const tokenXml =
    "<touchup><filePath>/__Installer/touchup.exe</filePath></touchup><runtime><launcher><filePath>[HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\SWGoH\\Install Dir]SWGoH.exe</filePath></launcher></runtime><gameTitle>Star Wars: Galaxy of Heroes</gameTitle><contentID>195217</contentID>"
  const tokenGame = eaGameFromInstallerXml(tokenXml, "D:\\EA\\SWGoH")
  expect(tokenGame?.iconPath).toBe("[HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\SWGoH\\Install Dir]SWGoH.exe")
  expect(tokenGame?.launchUrl).toBe("origin2://game/launch?offerIds=195217")
})

test("ea executable tokens expand to the registry install directory", async () => {
  const raw = "[HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\SWGoH\\Install Dir]SWGoH.exe"
  await expect(resolveEaFilePath(raw, "D:\\Wrong", async () => "D:\\EA\\SWGoH\\")).resolves.toBe("D:\\EA\\SWGoH\\SWGoH.exe")
  await expect(resolveEaFilePath(raw, "D:\\EA\\SWGoH", async () => "")).resolves.toBe("D:\\EA\\SWGoH\\SWGoH.exe")
  await expect(resolveEaFilePath("[INSTALLDIR]\\Game.exe", "D:\\Dragon Age")).resolves.toBe(path.win32.join("D:\\Dragon Age", "Game.exe"))
})

test("battle.net maps install ids onto client launch codes", () => {
  const games = battleNetGamesFromAggregate(
    { installed: [{ name: "Hearthstone", product_id: "hsb", launch_uri: "battlenet://hsb", icon_path: "C:/Games/Hearthstone/Hearthstone.exe" }] },
    "C:\\Battle.net\\Battle.net.exe"
  )
  expect(games[0].launchArgs).toEqual(["--exec=launch WTCG"])
  expect(games[0].launchUrl).toBe("C:\\Battle.net\\Battle.net.exe")
  const fromReg = battleNetGamesFromReg(
    [
      {
        key: "HKEY_LOCAL_MACHINE\\SOFTWARE\\Uninstall\\hsb",
        values: { DisplayName: "Hearthstone", UninstallString: "--uid=hsb", InstallLocation: "C:\\Hearthstone", DisplayIcon: '"C:\\Hearthstone\\Hearthstone.exe",0' }
      }
    ],
    ""
  )
  expect(fromReg[0].iconPath).toBe("C:\\Hearthstone\\Hearthstone.exe")
  expect(displayIconPath('"C:\\Hearthstone\\Hearthstone.exe",0')).toBe("C:\\Hearthstone\\Hearthstone.exe")
  expect(parseBattleNetLaunchCode(["--exec=launch WTCG"])).toBe("WTCG")
  expect(parseBattleNetSnapshot("window 1200")).toEqual({ state: "window", ageMs: 1200 })
  expect(parseBattleNetSnapshot("running 50\r\n")).toEqual({ state: "running", ageMs: 50 })
})

test("battle.net waits for the client window before sending the launch command", async () => {
  const exe = "C:\\Battle.net\\Battle.net.exe"
  const opened: Array<string[]> = []
  const open = async (_target: string, args: string[] = []) => {
    opened.push(args)
  }
  await launchBattleNetGame(exe, "WTCG", { open, snapshot: async () => ({ state: "window", ageMs: 1000 }) })
  expect(opened).toEqual([["--exec=launch WTCG"]])

  opened.length = 0
  const cold = ["absent", "running", "window"]
  let now = 0
  await launchBattleNetGame(exe, "Fen", {
    open,
    snapshot: async () => ({ state: (cold.shift() || "window") as "absent" | "running" | "window", ageMs: now }),
    sleep: async ms => {
      now += ms
    },
    now: () => now,
    pollMs: 500,
    timeoutMs: 5000
  })
  expect(opened).toEqual([[], ["--exec=launch Fen"]])

  opened.length = 0
  await launchBattleNetGame(exe, "WoW", {
    open,
    snapshot: async () => ({ state: "running", ageMs: 20000 }),
    sleep: async () => undefined,
    now: () => 0,
    pollMs: 500,
    timeoutMs: 5000
  })
  expect(opened).toEqual([["--exec=launch WoW"]])
})

test("ea launch sends origin2 only after a healthy client can accept it", async () => {
  const protocol = "origin2://game/launch?offerIds=195217"
  const launcher = "C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EALauncher.exe"
  expect(parseEaSnapshot("window 1200")).toEqual({ state: "window", ageMs: 1200 })
  expect(parseEaSnapshot("running 50\r\n")).toEqual({ state: "running", ageMs: 50 })

  const opened: Array<[string, string[] | undefined]> = []
  const open = async (target: string, args?: string[]) => {
    opened.push([target, args])
  }
  const ready = await launchEaGame(protocol, launcher, { open, snapshot: async () => ({ state: "window", ageMs: 1000 }) })
  expect(ready).toEqual({ mode: "ready", sawWindow: true })
  expect(opened).toEqual([[protocol, []]])

  opened.length = 0
  const tray = await launchEaGame(protocol, launcher, {
    open,
    snapshot: async () => ({ state: "running", ageMs: 20000 }),
    sleep: async () => undefined,
    now: () => 0
  })
  expect(tray).toEqual({ mode: "ready", sawWindow: false })
  expect(opened).toEqual([[protocol, []]])

  opened.length = 0
  const cold: Array<"absent" | "running" | "window"> = ["absent", "running", "window"]
  let now = 0
  const started = await launchEaGame(protocol, launcher, {
    open,
    snapshot: async () => ({ state: cold.shift() || "window", ageMs: now }),
    sleep: async ms => {
      now += ms
    },
    now: () => now,
    pollMs: 500,
    timeoutMs: 5000
  })
  expect(started).toEqual({ mode: "deferred", sawWindow: true })
  expect(opened).toEqual([
    [launcher, []],
    [protocol, []]
  ])

  opened.length = 0
  now = 0
  let polls = 0
  await expect(
    launchEaGame(protocol, launcher, {
      open,
      snapshot: async () => ({ state: polls++ === 0 ? "absent" : "running", ageMs: now }),
      sleep: async ms => {
        now += ms
      },
      now: () => now,
      pollMs: 500,
      timeoutMs: 1000
    })
  ).rejects.toThrow("EA App is still starting")
  expect(opened).toEqual([[launcher, []]])

  opened.length = 0
  now = 0
  await expect(
    launchEaGame(protocol, launcher, {
      open,
      snapshot: async () => ({ state: "absent", ageMs: 0 }),
      sleep: async ms => {
        now += ms
      },
      now: () => now,
      pollMs: 500,
      timeoutMs: 1000
    })
  ).rejects.toThrow("EA App did not start")
  expect(opened).toEqual([[launcher, []]])

  opened.length = 0
  await expect(launchEaGame(protocol, "", { open, snapshot: async () => ({ state: "absent", ageMs: 0 }) })).rejects.toThrow("EA App is not running")
  expect(opened).toEqual([])

  opened.length = 0
  const ages = [1000, 1000, 9000]
  const aged = await launchEaGame(protocol, launcher, {
    open,
    snapshot: async () => ({ state: "running", ageMs: ages.shift() ?? 9000 }),
    sleep: async () => undefined,
    now: () => 0,
    pollMs: 500,
    timeoutMs: 5000,
    readyAgeMs: 8000
  })
  expect(aged).toEqual({ mode: "deferred", sawWindow: false })
  expect(opened).toEqual([[protocol, []]])

  opened.length = 0
  const gone: Array<"absent" | "running" | "window"> = ["running", "absent"]
  await expect(
    launchEaGame(protocol, launcher, {
      open,
      snapshot: async () => ({ state: gone.shift() || "absent", ageMs: 1000 }),
      sleep: async () => undefined,
      now: () => 1000,
      pollMs: 500,
      timeoutMs: 1000,
      readyAgeMs: 8000
    })
  ).rejects.toThrow("EA App is still starting")
  expect(opened).toEqual([])
})

test("xbox config prefers the registered shell app", () => {
  const xml = `<Identity Name="Microsoft.Game" /><ShellVisuals DefaultDisplayName="Halo" /><Executable Name="game.exe" Id="App" />`
  const game = xboxGameFromConfig(xml, "D:\\Halo", [{ appid: "Microsoft.Game_abc!App", installDir: "D:\\Halo" }])
  expect(game?.launchUrl).toBe("shell:AppsFolder\\Microsoft.Game_abc!App")
  expect(game?.name).toBe("Halo")
})

test("xbox icon candidates prefer the scaled square logo over the splash image", () => {
  const xml = `<Executable Name="Minecraft.exe" OverrideSquare44x44Logo="SmallLogoOverride.png" /><ShellVisuals DefaultDisplayName="Minecraft Launcher" Square44x44Logo="Graphics/SmallLogo.png" Square150x150Logo="GraphicsLogo.png" SplashScreenImage="SplashScreen.png" StoreLogo="StoreLogo.png" />`
  const files = xboxIconCandidates(xml, "D:\\Launcher")
  const index = (name: string) => files.indexOf(path.win32.join("D:\\Launcher", name))
  expect(index("SmallLogoOverride.scale-200.png")).toBeGreaterThanOrEqual(0)
  expect(index("SmallLogoOverride.scale-200.png")).toBeLessThan(index("Graphics\\SmallLogo.scale-200.png"))
  expect(index("Graphics\\SmallLogo.scale-200.png")).toBeLessThan(index("Graphics\\SmallLogo.png"))
  expect(index("Graphics\\SmallLogo.png")).toBeLessThan(index("GraphicsLogo.png"))
  expect(index("GraphicsLogo.png")).toBeLessThan(index("StoreLogo.png"))
  expect(files.some(file => /SplashScreen/i.test(file))).toBe(false)
})

test("itch executable comes from the first action path", () => {
  expect(itchExecutable('[[actions]]\nname = "play"\npath = "Game.exe"\n')).toBe("Game.exe")
})

test("registry text and favorites parse loosely", () => {
  expect(parseRegSz("    SteamPath    REG_SZ    C:\\Steam\r\n", "SteamPath")).toBe("C:\\Steam")
  expect(parseRegSz("HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\SWGoH\r\n    Install Dir    REG_SZ    D:\\EA\\SWGoH\\\r\n", "Install Dir")).toBe("D:\\EA\\SWGoH\\")
  const tree = parseRegTree("HKEY_LOCAL_MACHINE\\SOFTWARE\\Example\\1\r\n    gameName    REG_SZ    Hades\r\n\r\nnot a key\r\n")
  expect(tree).toEqual([{ key: "HKEY_LOCAL_MACHINE\\SOFTWARE\\Example\\1", values: { gameName: "Hades" } }])
  expect(parseFavorites('["steam:570", ""]')).toEqual(["steam:570"])
  expect(parseFavorites("nope")).toEqual([])
})
