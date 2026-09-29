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

export async function primaryExe(deps: ScanDeps, dir: string): Promise<string> {
  if (!dir) return ""
  let names: string[] = []
  try {
    names = await deps.readdir(dir)
  } catch {
    return ""
  }
  const exes = names.filter(name => name.toLowerCase().endsWith(".exe") && !/unins|crash|redist|setup/i.test(name))
  await deps.report?.("executable_selection", {
    dir,
    candidates: exes,
    selected: exes.length === 1 ? exes[0] : "",
    reason: exes.length === 1 ? "unique_executable" : "no_unambiguous_executable"
  })
  if (exes.length === 1) return path.join(dir, exes[0])
  return ""
}
