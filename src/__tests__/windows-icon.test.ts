import fs from "fs"
import os from "os"
import path from "path"
import { createScanDeps } from "../deps"
import { materializeWindowsIcon } from "../files"
import { encodePng } from "../ico"
import { extractWindowsIcon } from "../windows-icon"

const png = encodePng(1, 1, Buffer.from([255, 0, 0, 255]))

function iconDeps() {
  const deps = createScanDeps()
  const files = new Map<string, Buffer>([["D:\\Games\\Game.exe", Buffer.from("exe")]])
  deps.platform = "win32"
  deps.cacheDir = "C:\\cache"
  deps.exists = async file => files.has(file)
  deps.fileVersion = jest.fn(async () => "100:1")
  deps.readBinary = async file => {
    const data = files.get(file)
    if (!data) throw new Error("missing file")
    return data
  }
  deps.writeBinary = jest.fn(async (file, data) => {
    files.set(file, data)
  })
  deps.extractWindowsIcon = jest.fn(async () => png)
  return { deps, files }
}

test("cache reuses PNGs and invalidates them when the source changes", async () => {
  const { deps } = iconDeps()
  const first = await materializeWindowsIcon(deps, "D:\\Games\\Game.exe")
  expect(first?.iconType).toBe("absolute")
  expect(await materializeWindowsIcon(deps, "D:\\Games\\Game.exe")).toEqual(first)
  expect(deps.extractWindowsIcon).toHaveBeenCalledTimes(1)
  deps.fileVersion = async () => "200:2"
  const updated = await materializeWindowsIcon(deps, "D:\\Games\\Game.exe")
  expect(updated?.iconPath).not.toBe(first?.iconPath)
  expect(deps.extractWindowsIcon).toHaveBeenCalledTimes(2)
})

test("same executable names in different directories do not collide", async () => {
  const { deps, files } = iconDeps()
  files.set("E:\\Games\\Game.exe", Buffer.from("exe"))
  const first = await materializeWindowsIcon(deps, "D:\\Games\\Game.exe")
  const second = await materializeWindowsIcon(deps, "E:\\Games\\Game.exe")
  expect(second?.iconPath).not.toBe(first?.iconPath)
})

test("corrupt cached PNGs are regenerated", async () => {
  const { deps, files } = iconDeps()
  const first = await materializeWindowsIcon(deps, "D:\\Games\\Game.exe")
  files.set(first!.iconPath, png.subarray(0, png.length - 12))
  expect(await materializeWindowsIcon(deps, "D:\\Games\\Game.exe")).toEqual(first)
  expect(deps.extractWindowsIcon).toHaveBeenCalledTimes(2)
  expect(files.get(first!.iconPath)).toEqual(png)
})

test("unsupported ICO data falls back to Windows extraction", async () => {
  const { deps, files } = iconDeps()
  files.set("D:\\Games\\old.ico", Buffer.from("unsupported ICO"))
  expect((await materializeWindowsIcon(deps, "D:\\Games\\old.ico"))?.iconType).toBe("absolute")
  expect(deps.extractWindowsIcon).toHaveBeenCalledWith("D:\\Games\\old.ico")
})

test("existing artwork bypasses extraction and cache requirements", async () => {
  const { deps, files } = iconDeps()
  files.set("D:\\Games\\art.png", png)
  deps.cacheDir = ""
  expect(await materializeWindowsIcon(deps, "D:\\Games\\art.png")).toEqual({ iconPath: "D:\\Games\\art.png", iconType: "absolute" })
  expect(deps.extractWindowsIcon).not.toHaveBeenCalled()
})

test.each(["missing source", "no cache", "timeout", "invalid output", "write denied"])("optional icon failure: %s", async failure => {
  const { deps } = iconDeps()
  if (failure === "missing source") deps.exists = async () => false
  if (failure === "no cache") deps.cacheDir = ""
  if (failure === "timeout")
    deps.extractWindowsIcon = async () => {
      throw new Error("timeout")
    }
  if (failure === "invalid output") deps.extractWindowsIcon = async () => Buffer.from("not a PNG")
  if (failure === "write denied")
    deps.writeBinary = async () => {
      throw new Error("access denied")
    }
  expect(await materializeWindowsIcon(deps, "D:\\Games\\Game.exe")).toBeNull()
})

test("other platforms retain native executable icons without starting PowerShell", async () => {
  const { deps } = iconDeps()
  deps.platform = "linux"
  expect(await materializeWindowsIcon(deps, "D:\\Games\\Game.exe")).toEqual({ iconPath: "D:\\Games\\Game.exe", iconType: "fileicon" })
  expect(deps.extractWindowsIcon).not.toHaveBeenCalled()
})

const windowsTest = process.platform === "win32" ? test : test.skip

windowsTest(
  "Windows extracts a real EXE and safely handles Unicode and metacharacters in ICO paths",
  async () => {
    const exeIcon = await extractWindowsIcon(process.execPath)
    expect(exeIcon.subarray(0, 8)).toEqual(png.subarray(0, 8))
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wox-icon-test-"))
    // An ICO directory entry containing a PNG frame.
    const header = Buffer.alloc(22)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(1, 4)
    header[6] = 1
    header[7] = 1
    header.writeUInt16LE(1, 10)
    header.writeUInt16LE(32, 12)
    header.writeUInt32LE(png.length, 14)
    header.writeUInt32LE(22, 18)
    const file = path.join(dir, "Assassin's Creed 日本語 $(); &.ico")
    try {
      await fs.promises.writeFile(file, Buffer.concat([header, png]))
      const result = await extractWindowsIcon(file)
      expect(result.subarray(0, 8)).toEqual(png.subarray(0, 8))
      expect(result.readUInt32BE(16)).toBe(1)
      expect(result.readUInt32BE(20)).toBe(1)
    } finally {
      await fs.promises.unlink(file).catch(() => undefined)
      await fs.promises.rmdir(dir)
    }
  },
  20000
)
