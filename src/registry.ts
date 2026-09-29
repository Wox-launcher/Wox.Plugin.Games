import { REG_TIMEOUT_MS } from "./constants"
import { errorDetails } from "./errors"
import { captureCommand, commandStdout, isMissingKey } from "./process"
import { ScanReport } from "./types"

export interface RegEntry {
  key: string
  values: Record<string, string>
}

export function parseRegSz(output: string, valueName: string): string {
  const wanted = String(valueName || "").toLowerCase()
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+REG_\w+\s+(.*)$/.exec(line)
    if (match && match[1].toLowerCase() === wanted) return match[2].trim()
  }
  return ""
}

export function parseRegTree(output: string): RegEntry[] {
  const entries: RegEntry[] = []
  const blocks = String(output || "").split(/\r?\n\r?\n/)
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter(line => line.trim())
    if (!lines.length || !lines[0].trim().startsWith("HKEY_")) continue
    const values: Record<string, string> = {}
    for (const line of lines.slice(1)) {
      const match = /^\s+(.+?)\s+REG_\w+\s+(.*)$/.exec(line)
      if (match) values[match[1].trim()] = match[2].trim()
    }
    entries.push({ key: lines[0].trim(), values })
  }
  return entries
}

export function leafKey(key: string): string {
  const parts = String(key || "").split("\\")
  return parts[parts.length - 1] || ""
}

function unwrapQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1).trim()
  return value
}

/** DisplayIcon is either a path or `path,index`, and either form may be quoted. */
export function displayIconPath(value: string): string {
  let icon = unwrapQuotes(String(value || "").trim())
  const comma = icon.lastIndexOf(",")
  if (comma > 1 && /^\d+$/.test(icon.slice(comma + 1).trim())) icon = icon.slice(0, comma).trim()
  return unwrapQuotes(icon)
}

/** reg.exe writes the console code page. Force UTF-8 before reading localized values. */
export async function spawnReg(args: string[], timeoutMs: number, report?: ScanReport): Promise<string> {
  const quoted = args.map((arg, index) => (index === 0 || String(arg).startsWith("/") ? arg : `"${String(arg).replace(/["&|<>^%\r\n]/g, "")}"`)).join(" ")
  try {
    return await captureCommand("cmd.exe", ["/d", "/c", `chcp 65001>nul & reg ${quoted}`], timeoutMs, { windowsVerbatimArguments: true })
  } catch (err) {
    // Missing launcher keys are normal. Timeouts and access errors must remain distinguishable.
    await report?.("registry_failed", { args, ...errorDetails(err) }, isMissingKey(err) ? "Info" : "Warning")
    return commandStdout(err)
  }
}

export function regQuery(key: string, valueName: string, report?: ScanReport): Promise<string> {
  return spawnReg(["query", key, "/v", valueName], REG_TIMEOUT_MS, report).then(output => parseRegSz(output, valueName))
}

export function regQueryTree(key: string, report?: ScanReport): Promise<string> {
  return spawnReg(["query", key, "/s"], 15000, report)
}
