import { spawn, SpawnOptions } from "child_process"
import fs from "fs"
import path from "path"
import { errorDetails } from "./errors"
import { parseRegTree, regQueryTree } from "./registry"
import { ScanReport } from "./types"

export interface LaunchDispatch {
  pid?: number
  method: string
  command: string
  cwd?: string
}

export interface OpenExternalOptions {
  platform?: NodeJS.Platform
  isLaunch?: boolean
  cwd?: string
  spawn?: typeof spawn
  regQueryTree?: typeof regQueryTree
  report?: ScanReport
}

/**
 * Node quotes an argument that contains whitespace, which already makes `&` literal.
 * Otherwise escape cmd metacharacters so Epic and EA query strings are not split.
 */
function cmdStartToken(value: string): string {
  const cleaned = value.replace(/["\r\n]/g, "")
  if (/[\s]/.test(cleaned)) return cleaned
  return cleaned.replace(/([&|<>^])/g, "^$1")
}

/** Wait for OS dispatch errors, not for the game to exit. A handoff is not proof that a game reached its main window. */
export function openExternal(target: string, args: string[] = [], options: OpenExternalOptions = {}): Promise<LaunchDispatch> {
  const value = String(target || "").trim()
  const argv = Array.isArray(args) ? args.map(String) : []
  if (!value) return Promise.reject(new Error("Launch target is empty"))
  return dispatch(value, argv, options)
}

async function dispatch(value: string, argv: string[], options: OpenExternalOptions): Promise<LaunchDispatch> {
  const platform = options.platform || process.platform
  let command = value
  let commandArgs = argv
  let cwd: string | undefined
  let method = "executable"
  let waitForExit = false
  let pipeStderr = false
  if (platform === "win32") {
    let direct = false
    if (path.win32.isAbsolute(value)) {
      const stat = await fs.promises.stat(value)
      if (options.isLaunch && stat.isDirectory()) {
        const err = new Error("A game installation directory is not a launch command") as NodeJS.ErrnoException
        err.code = "EISDIR"
        err.path = value
        throw err
      }
      direct = stat.isFile() && /\.(exe|com)$/i.test(value)
      if (direct) cwd = options.cwd || path.win32.dirname(value)
    }
    if (/^shell:AppsFolder\\/i.test(value)) {
      command = path.join(process.env.SystemRoot || "C:\\Windows", "explorer.exe")
      commandArgs = [value]
      method = "registered_app"
    } else if (!direct) {
      const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1]
      if (scheme && !path.win32.isAbsolute(value)) {
        const registration = await (options.regQueryTree || regQueryTree)(`HKCR\\${scheme}\\shell\\open\\command`, options.report)
        await options.report?.("protocol_handler", {
          scheme,
          registered: !!registration,
          registryKey: `HKCR\\${scheme}\\shell\\open\\command`,
          handler: parseRegTree(registration).flatMap(entry => Object.values(entry.values))
        })
        if (!registration) {
          const err = new Error(`No application is registered for protocol ${scheme}`) as NodeJS.ErrnoException
          err.code = "EPROTONOSUPPORT"
          throw err
        }
      }
      // PowerShell started with Node's DETACHED_PROCESS flag exits without running -Command.
      // cmd.exe still runs, and `start` returns as soon as Windows accepts the target.
      command = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe")
      commandArgs = ["/c", "start", "", cmdStartToken(value), ...argv.map(cmdStartToken)]
      method = scheme ? "protocol" : "shell"
      waitForExit = true
    }
  } else {
    command = platform === "darwin" ? "open" : "xdg-open"
    commandArgs = [value]
    method = "shell"
    waitForExit = true
    pipeStderr = true
  }
  return startProcess(command, commandArgs, { method, cwd, waitForExit, pipeStderr, spawnImpl: options.spawn, report: options.report })
}

function startProcess(
  command: string,
  commandArgs: string[],
  options: { method: string; cwd?: string; waitForExit: boolean; pipeStderr?: boolean; spawnImpl?: typeof spawn; report?: ScanReport }
): Promise<LaunchDispatch> {
  const spawnImpl = options.spawnImpl || spawn
  const spawnOptions: SpawnOptions = {
    detached: true,
    stdio: options.pipeStderr ? ["ignore", "ignore", "pipe"] : "ignore",
    windowsHide: true,
    cwd: options.cwd
  }
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, commandArgs, spawnOptions)
    const result: LaunchDispatch = { pid: child.pid, method: options.method, command, cwd: options.cwd }
    let dispatched = false
    let stderr = ""
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4096)
    })
    const timer = options.waitForExit
      ? setTimeout(() => {
          child.kill()
          child.stderr?.destroy()
          const err = new Error("Shell dispatch timed out after 15000ms") as NodeJS.ErrnoException
          err.code = "ETIMEDOUT"
          reject(err)
        }, 15000)
      : null
    child.on("spawn", () => {
      void options.report?.("process_started", { ...result })
      if (!options.waitForExit) {
        dispatched = true
        child.unref()
        resolve(result)
      }
    })
    child.on("error", err => {
      if (timer) clearTimeout(timer)
      if (dispatched) void options.report?.("process_failed", { ...result, ...errorDetails(err) }, "Error")
      else reject(err)
    })
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer)
      void options.report?.("process_exit", { ...result, exitCode: code, signal, stderr: stderr.trim(), handoffOnly: options.method !== "executable" }, code === 0 ? "Info" : "Warning")
      if (!options.waitForExit) return
      if (code === 0) resolve(result)
      else reject(Object.assign(new Error(stderr.trim() || `Shell dispatch exited with code ${code}`), { code, signal }))
    })
  })
}
