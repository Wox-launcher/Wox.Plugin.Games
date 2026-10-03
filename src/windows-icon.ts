import { execFile } from "child_process"
import path from "path"
import { promisify } from "util"

const runFile = promisify(execFile)

/** Windows PowerShell uses the Windows/.NET Framework icon APIs, including on Windows 10. */
export async function extractWindowsIcon(file: string): Promise<Buffer> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Drawing",
    "$icon = $null; $bitmap = $null; $stream = $null",
    "try {",
    "  if ([IO.Path]::GetExtension($env:WOX_GAME_ICON_SOURCE) -ieq '.ico') {",
    "    $icon = [Drawing.Icon]::new($env:WOX_GAME_ICON_SOURCE)",
    "  } else {",
    "    $icon = [Drawing.Icon]::ExtractAssociatedIcon($env:WOX_GAME_ICON_SOURCE)",
    "  }",
    "  if ($null -eq $icon) { throw 'No icon resource found' }",
    "  $bitmap = $icon.ToBitmap()",
    "  $stream = [IO.MemoryStream]::new()",
    "  $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)",
    "  [Console]::Write([Convert]::ToBase64String($stream.ToArray()))",
    "} finally {",
    "  if ($null -ne $stream) { $stream.Dispose() }",
    "  if ($null -ne $bitmap) { $bitmap.Dispose() }",
    "  if ($null -ne $icon) { $icon.Dispose() }",
    "}"
  ].join("\n")
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const { stdout } = await runFile(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 8000,
    maxBuffer: 2 * 1024 * 1024,
    // Paths remain data, including apostrophes, Unicode and PowerShell metacharacters.
    env: { ...process.env, WOX_GAME_ICON_SOURCE: file }
  })
  return Buffer.from(stdout.trim(), "base64")
}
