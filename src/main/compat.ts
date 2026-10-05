import { ipcMain } from 'electron'
import type { Settings } from '@shared/settings'
import type { SettingsStore } from './settings-store'

/**
 * Site compatibility: which browser we present as, and the Google sign-in fix.
 *
 * Google refuses sign-in from browsers it thinks are embedded ("This browser
 * or app may not be secure"). Our network identity is plain Chrome; what gives
 * Electron away is the page environment: an empty `window.chrome` (real Chrome
 * has `chrome.app`, `chrome.csi` and `chrome.loadTimes`). On Google's sign-in
 * page only, the page preload fills those in. Passkeys are hidden there too:
 * Electron has no macOS platform authenticator, so Google's passkey step would
 * hang instead of offering the password.
 */
export const PAGE_CONFIG_CHANNEL = 'zepper:page-config'

export interface PageConfig {
  /** Apply the Google sign-in shim (accounts.google.com only). */
  signInCompat: boolean
  /** Presenting as a non-Chromium browser: hide Chromium-only page APIs. */
  hideChromium: boolean
  /** navigator.vendor for the browser we present as. */
  vendor: string
}

const FIREFOX_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0'
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'

/** The user agent for the chosen identity, built on our plain Chrome one. */
export function userAgentFor(settings: Settings, chromeUa: string): string {
  const major = /Chrome\/(\d+)/.exec(chromeUa)?.[1] ?? process.versions.chrome.split('.')[0]
  switch (settings.userAgent) {
    case 'edge':
      return `${chromeUa} Edg/${major}.0.0.0`
    case 'firefox':
      return FIREFOX_UA
    case 'safari':
      return SAFARI_UA
    case 'custom':
      return settings.customUserAgent.trim() || chromeUa
    default:
      return chromeUa
  }
}

export function isChromiumUa(ua: string): boolean {
  return /Chrome\/\d/.test(ua) && !/Firefox\/|Version\/[\d.]+ Safari\//.test(ua)
}

/**
 * Client hints that match the user agent: none for Firefox or Safari (they
 * don't send them), an Edge brand for Edge.
 */
export function clientHintHeaders(headers: Record<string, string>, ua: string): Record<string, string> {
  if (!isChromiumUa(ua)) {
    const next: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) if (!/^sec-ch-ua/i.test(key)) next[key] = value
    return next
  }
  const edge = / Edg\/(\d+)/.exec(ua)
  if (!edge) return headers
  const next = { ...headers }
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === 'sec-ch-ua') {
      next[key] = `"Chromium";v="${edge[1]}", "Microsoft Edge";v="${edge[1]}", "Not)A;Brand";v="24"`
    }
  }
  return next
}

export function servePageConfig(settings: SettingsStore, currentUa: () => string): void {
  ipcMain.on(PAGE_CONFIG_CHANNEL, (event) => {
    const ua = currentUa()
    const chromium = isChromiumUa(ua)
    const config: PageConfig = {
      signInCompat: chromium && settings.get().googleSignInCompat,
      hideChromium: !chromium,
      vendor: /Version\/[\d.]+ Safari\//.test(ua) ? 'Apple Computer, Inc.' : chromium ? 'Google Inc.' : ''
    }
    event.returnValue = config
  })
}
