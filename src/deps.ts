import fs from "fs"
import os from "os"
import { fileExists } from "./files"
import { regQuery, regQueryTree } from "./registry"
import { ScanDeps } from "./types"
import { windowsInventory } from "./windows"

export function createScanDeps(): ScanDeps {
  return {
    platform: process.platform,
    homedir: os.homedir(),
    exists: file => fileExists(file),
    readFile: file => fs.promises.readFile(file, "utf8"),
    readdir: dir => fs.promises.readdir(dir),
    regQuery,
    regQueryTree,
    windowsInventory,
    appData: process.env.APPDATA || "",
    publicDir: process.env.PUBLIC || "",
    programData: process.env.ProgramData || process.env.PROGRAMDATA || "",
    programFiles: process.env.ProgramFiles || "C:\\Program Files",
    programFilesX86: process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"
  }
}
