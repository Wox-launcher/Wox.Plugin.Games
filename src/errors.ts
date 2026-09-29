export interface CommandError extends Error {
  code?: string | number
  signal?: NodeJS.Signals | number | null
  stdout?: string
  syscall?: string
  path?: string
}

export function commandError(message: string, extra: Partial<CommandError> = {}): CommandError {
  const err = new Error(message) as CommandError
  Object.assign(err, extra)
  return err
}

export function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return String(err)
}

export function errorCode(err: unknown): string | number | undefined {
  if (typeof err !== "object" || !err || !("code" in err)) return undefined
  const code = (err as { code?: unknown }).code
  if (typeof code === "string" || typeof code === "number") return code
  return undefined
}

export function errorDetails(err: unknown): Record<string, unknown> {
  const extra = typeof err === "object" && err ? (err as CommandError) : undefined
  return {
    error: errorText(err),
    errorCode: extra?.code,
    syscall: extra?.syscall,
    path: extra?.path,
    signal: extra?.signal
  }
}
