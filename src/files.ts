import fs from "fs"
import path from "path"
import { errorCode } from "./errors"
import { ScanDeps } from "./types"

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
