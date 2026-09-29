import { spawn } from "child_process"
import { commandError, CommandError, errorCode } from "./errors"

export interface CapturedCommand {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
}

export function captureCommand(command: string, args: string[], timeoutMs: number, options: { windowsVerbatimArguments?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      child.kill()
      child.stdout?.destroy()
      child.stderr?.destroy()
      reject(commandError(`Command timed out after ${timeoutMs}ms`, { code: "ETIMEDOUT", stdout: Buffer.concat(stdout).toString("utf8") }))
    }, timeoutMs)
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const result: CapturedCommand = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
        code,
        signal
      }
      if (code !== 0) {
        reject(commandError(result.stderr || `Command exited with code ${code}`, { code: code ?? undefined, signal, stdout: result.stdout }))
        return
      }
      resolve(result.stdout)
    })
  })
}

export function commandStdout(err: unknown): string {
  if (typeof err === "object" && err && "stdout" in err) {
    const stdout = (err as CommandError).stdout
    return typeof stdout === "string" ? stdout : ""
  }
  return ""
}

export function isMissingKey(err: unknown): boolean {
  return errorCode(err) === 1
}
