import { ItchLauncher } from "../launchers/itch"
import { createScanDeps } from "../deps"
import { encodePng } from "../ico"

jest.mock(
  "node:sqlite",
  () => ({
    DatabaseSync: class {
      prepare() {
        return { all: () => [{ caveId: 123, title: "Game", installDir: "D:\\itch\\Game" }] }
      }
      close() {}
    }
  }),
  { virtual: true }
)

test("itch converts the action executable while preserving the cave launch URI", async () => {
  const deps = createScanDeps()
  deps.platform = "win32"
  deps.appData = "C:\\Users\\me\\AppData\\Roaming"
  deps.cacheDir = "C:\\cache"
  deps.exists = async file => !file.includes("\\icons\\")
  deps.readFile = async () => '[[actions]]\npath = "Game.exe"'
  deps.fileVersion = async () => "100:1"
  deps.extractWindowsIcon = jest.fn(async () => encodePng(1, 1, Buffer.from([255, 0, 0, 255])))
  deps.writeBinary = jest.fn(async () => undefined)
  const found = await new ItchLauncher().scan(deps)
  expect(found.games).toHaveLength(1)
  expect(found.games[0].launchUrl).toBe("itch://caves/123/launch")
  expect(found.games[0].iconType).toBe("absolute")
  expect(deps.extractWindowsIcon).toHaveBeenCalledWith("D:\\itch\\Game\\Game.exe")
})
