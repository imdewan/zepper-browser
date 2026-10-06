import { app } from 'electron'
import { join } from 'node:path'

/**
 * Zepper's native credentials addon (native/credentials, built by npm run build:credentials):
 * passkeys through macOS, and the Apple Passwords picker. Absent (not built, or not macOS),
 * those features simply stay off.
 */
export interface CredentialsAddon {
  /** Whether this process may use passkeys (Apple's browser entitlement). */
  available(): boolean
  perform(windowHandle: Buffer, request: string): Promise<string>
  cancel(): void
  /** Shows the Apple Passwords picker panel at a point in the window; resolves a login JSON or "null". */
  pickPassword(windowHandle: Buffer, place: string): Promise<string>
  cancelPick(): void
}

let addon: CredentialsAddon | null | undefined

export function credentialsAddon(): CredentialsAddon | null {
  if (addon !== undefined) return addon
  addon = null
  if (process.platform !== 'darwin') return null
  const path = app.isPackaged
    ? join(process.resourcesPath, 'bin', 'zepper_credentials.node')
    : join(app.getAppPath(), 'build', 'bin', 'zepper_credentials.node')
  try {
    const module = { exports: {} as CredentialsAddon }
    process.dlopen(module, path)
    addon = module.exports
  } catch {
    // Not built.
  }
  return addon
}
