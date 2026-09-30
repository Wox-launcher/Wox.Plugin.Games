import fs from "fs"
import { createHash } from "crypto"
import path from "path"
import { errorCode, errorDetails } from "./errors"
import { pngFromIco } from "./ico"
import { InstalledGame, ScanDeps } from "./types"

export function fileExists(file: string): Promise<boolean> {
  return fs.promises
    .access(file)
    .then(() => true)
    .catch((err: unknown) => {
      const code = errorCode(err)
      if (code === "ENOENT" || code === "ENOTDIR") return false
      throw err
    })
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** Reject interrupted cache writes, including files that contain only the PNG header. */
function completePng(data: Buffer): boolean {
  if (data.length < 45 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return false
  if (data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR" || !data.readUInt32BE(16) || !data.readUInt32BE(20)) return false
  let hasData = false
  for (let offset = 8; offset + 12 <= data.length; ) {
    const length = data.readUInt32BE(offset)
    const end = offset + length + 12
    if (end > data.length) return false
    const type = data.toString("ascii", offset + 4, offset + 8)
    if (type === "IDAT") hasData = true
    if (type === "IEND") return hasData && length === 0 && end === data.length
    offset = end
  }
  return false
}

/** Give Wox an ordinary image instead of asking it to interpret Windows icon resources. */
export async function materializeWindowsIcon(deps: ScanDeps, sourcePath: string): Promise<{ iconPath: string; iconType: string } | null> {
  if (!sourcePath) return null
  try {
    if (!(await deps.exists(sourcePath))) return null
    if (/\.(png|jpe?g|gif|bmp|webp)$/i.test(sourcePath)) return { iconPath: sourcePath, iconType: "absolute" }
    // itch.io also scans other platforms; preserve its native file icons there.
    if (deps.platform !== "win32") return { iconPath: sourcePath, iconType: "fileicon" }
    if (!/\.(exe|ico|dll)$/i.test(sourcePath) || !deps.cacheDir || !deps.readBinary || !deps.writeBinary) return null
    const version = deps.fileVersion ? await deps.fileVersion(sourcePath) : ""
    const key = createHash("sha256")
      .update(`windows-icon-v1\0${path.win32.normalize(sourcePath).toLowerCase()}\0${version}`)
      .digest("hex")
    const out = path.win32.join(deps.cacheDir, "icons", `${key}.png`)
    if (await deps.exists(out)) {
      try {
        const cached = await deps.readBinary(out)
        if (completePng(cached)) return { iconPath: out, iconType: "absolute" }
      } catch {
        // A partial or unreadable cache entry can be regenerated.
      }
    }
    let png: Buffer | null = null
    if (/\.ico$/i.test(sourcePath)) png = pngFromIco(await deps.readBinary(sourcePath))
    if (!png && deps.extractWindowsIcon) png = await deps.extractWindowsIcon(sourcePath)
    if (!png || !completePng(png)) return null
    await deps.writeBinary(out, png)
    return { iconPath: out, iconType: "absolute" }
  } catch (err) {
    void deps.report?.("icon_materialization_failed", { sourcePath, ...errorDetails(err) }, "Warning")
    return null
  }
}

/** Preserve the launch target while assigning a derived image or the plugin fallback. */
export async function applyGameIcon(deps: ScanDeps, game: InstalledGame, sourcePath = game.iconPath): Promise<void> {
  const icon = await materializeWindowsIcon(deps, sourcePath)
  game.iconPath = icon?.iconPath || ""
  game.iconType = icon?.iconType || ""
}

/** Installers, crash handlers, and anti-cheat bootstrappers. Their icons are not the game's icon. */
export function isHelperExecutable(file: string): boolean {
  return /unins|crash|redist|setup|anticheat|touchup|cleanup/i.test(path.win32.basename(String(file || "")))
}

export async function primaryExe(deps: ScanDeps, dir: string): Promise<string> {
  if (!dir) return ""
  let names: string[] = []
  try {
    names = await deps.readdir(dir)
  } catch {
    return ""
  }
  const exes = names.filter(name => name.toLowerCase().endsWith(".exe") && !isHelperExecutable(name))
  await deps.report?.("executable_selection", {
    dir,
    candidates: exes,
    selected: exes.length === 1 ? exes[0] : "",
    reason: exes.length === 1 ? "unique_executable" : "no_unambiguous_executable"
  })
  if (exes.length === 1) return path.join(dir, exes[0])
  return ""
}
