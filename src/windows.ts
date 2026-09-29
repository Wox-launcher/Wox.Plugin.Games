import { captureCommand } from "./process"
import { ScanReport, WindowsInventory } from "./types"

const INVENTORY_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$errors = @()
$drives = @()
$apps = @()
$packages = @{}
try { $drives = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $_.DeviceID + '\\' }) } catch { $errors += 'drives: ' + $_.Exception.Message }
try { Get-AppxPackage | ForEach-Object { $packages[$_.PackageFamilyName] = $_.InstallLocation } } catch { $errors += 'packages: ' + $_.Exception.Message }
try {
  $folder = (New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder')
  if (!$folder) { throw 'Shell AppsFolder is unavailable' }
  $apps = @($folder.Items() | ForEach-Object {
    $id = $_.ExtendedProperty('System.AppUserModel.ID')
    if (!$id) { $id = $_.Path }
    $family = $_.ExtendedProperty('System.AppUserModel.PackageFamilyName')
    if (!$family -and $id -like '*!*') { $family = $id.Split('!')[0] }
    if ($id -and $family) { [pscustomobject]@{ name=$_.Name; appid=$id; family=$family; installDir=$packages[$family] } }
  })
} catch { $errors += 'apps: ' + $_.Exception.Message }
[pscustomobject]@{ drives=$drives; apps=$apps; errors=$errors } | ConvertTo-Json -Depth 4 -Compress
`

interface InventoryPayload {
  drives?: string[]
  apps?: WindowsInventory["apps"]
  errors?: string[]
}

/** Discover fixed drives and the same Shell registration used by the Windows app list. */
export async function windowsInventory(report?: ScanReport): Promise<WindowsInventory> {
  const raw = await captureCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(INVENTORY_SCRIPT, "utf16le").toString("base64")], 30000)
  const result = JSON.parse(raw.replace(/^\uFEFF/, "")) as InventoryPayload
  for (const error of result.errors || []) await report?.("windows_inventory_error", { error }, "Warning")
  return { apps: result.apps || [], drives: result.drives || [], errors: result.errors || [] }
}
