import { ipcMain } from 'electron'
import type { SettingsStore } from './settings-store'

/**
 * Google refuses sign-in from browsers it thinks are embedded ("This browser
 * or app may not be secure"). Our network identity is already plain Chrome;
 * what gives Electron away is the page environment: an empty `window.chrome`
 * (real Chrome has `chrome.app`, `chrome.csi` and `chrome.loadTimes`). On
 * Google's sign-in page only, the page preload fills those in.
 *
 * Passkeys are hidden there too: Electron has no macOS platform authenticator,
 * so Google's passkey step would hang instead of offering the password.
 */
export const SIGN_IN_COMPAT_CHANNEL = 'zepper:sign-in-compat'

export function serveSignInCompat(settings: SettingsStore): void {
  ipcMain.on(SIGN_IN_COMPAT_CHANNEL, (event) => {
    event.returnValue = settings.get().googleSignInCompat
  })
}
