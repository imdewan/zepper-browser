import { app, systemPreferences } from 'electron'
import { join } from 'node:path'

/**
 * Zepper's native credentials addon (native/credentials, built by npm run build:credentials):
 * the system's passkeys (with Apple's browser entitlement), proving you're the Mac's owner, and
 * reading another browser's Keychain key for imports. Absent (not built, or not macOS), those
 * features fall back or stay off.
 */
export interface CredentialsAddon {
  /** Whether this process may use the system's passkeys (Apple's browser entitlement). */
  available(): boolean
  perform(windowHandle: Buffer, request: string): Promise<string>
  cancel(): void
  verifyOwner(reason: string): Promise<string>
  readKeychain(service: string, account: string): Promise<string>
  /** Scans for Bluetooth LE advertisements with these 16-bit service UUIDs, reporting JSON events. */
  bleScan(services: string, onEvent: (json: string) => void): void
  bleStop(): void
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

/**
 * Asks for Touch ID (or your Mac's password) before something sensitive. "unavailable" when this
 * Mac has no way to check (no password set), so callers decide whether that's acceptable.
 */
export async function verifyOwner(reason: string): Promise<boolean | 'unavailable'> {
  const native = credentialsAddon()
  if (native) {
    const result = JSON.parse(await native.verifyOwner(reason)) as boolean | 'unavailable'
    return result
  }
  if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
    return systemPreferences.promptTouchID(reason).then(
      () => true,
      () => false
    )
  }
  return 'unavailable'
}

/** A generic password from the Keychain (macOS asks you to allow it); null if refused or missing. */
export async function readKeychain(service: string, account: string): Promise<string | null> {
  const native = credentialsAddon()
  if (!native) return null
  const result = JSON.parse(await native.readKeychain(service, account)) as [string] | null
  return result ? result[0] : null
}
