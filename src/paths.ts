import path from "path"

export function dedupePaths(paths: string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const raw of paths) {
    const pathApi = platform === "win32" ? path.win32 : path
    let cleaned = pathApi.normalize(
      String(raw || "")
        .trim()
        .replace(/^"|"$/g, "")
    )
    if (cleaned !== pathApi.parse(cleaned).root) cleaned = cleaned.replace(/[\\/]+$/, "")
    if (!cleaned || cleaned === ".") continue
    const key = platform === "win32" ? cleaned.toLowerCase() : cleaned
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(cleaned)
  }
  return unique
}
