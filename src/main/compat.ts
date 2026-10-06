import { ipcMain } from 'electron'
import type { Settings } from '@shared/settings'
import type { SettingsStore } from './settings-store'
import { fingerprintSeed } from './shields'

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
  /** Widevine is turned off: refuse it to pages (even if it's installed) and notice who asks. */
  blockWidevine: boolean
  /** ...and offer to turn it on when a site asks. */
  askForWidevine: boolean
  /** Global Privacy Control: also expose navigator.globalPrivacyControl (the header alone isn't enough). */
  globalPrivacyControl: boolean
  /** Seed for fingerprinting noise on this site (null: protection off here). */
  fingerprintSeed: number | null
  /** The browser brand pages see in navigator.userAgentData, matching the headers (null: leave as is). */
  brand: { name: string; major: string; full: string } | null
  /** Answer WebAuthn (passkeys) with Zepper's password manager: top-level secure pages. */
  passkeys: boolean
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
  if (!edge) {
    // Presenting as Chrome: the brand list says Google Chrome, as Chrome's does (Electron's says only Chromium).
    const major = /Chrome\/(\d+)/.exec(ua)?.[1]
    const next = { ...headers }
    for (const key of Object.keys(next)) {
      if (key.toLowerCase() === 'sec-ch-ua' && major)
        next[key] = `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not?A_Brand";v="24"`
    }
    return next
  }
  const next = { ...headers }
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === 'sec-ch-ua') {
      next[key] = `"Chromium";v="${edge[1]}", "Microsoft Edge";v="${edge[1]}", "Not)A;Brand";v="24"`
    }
  }
  return next
}

export function servePageConfig(settings: SettingsStore, currentUa: () => string, protects: (pageUrl: string) => boolean): void {
  ipcMain.on(PAGE_CONFIG_CHANNEL, (event) => {
    let pageUrl = ''
    let siteUrl = ''
    let topLevel = false
    try {
      pageUrl = event.senderFrame?.url ?? ''
      topLevel = event.senderFrame?.parent === null
      // Protections follow the site you're on: an embedded frame gets that site's noise and switches, so a
      // tracker embedded on many sites can't use them to recognise you.
      siteUrl = event.senderFrame?.top?.url ?? pageUrl
    } catch {
      // The frame went away.
    }
    const ua = currentUa()
    const chromium = isChromiumUa(ua)
    const { googleSignInCompat, widevine, widevinePrompt, globalPrivacyControl, blockFingerprinting } = settings.get()
    const config: PageConfig = {
      signInCompat: chromium && googleSignInCompat,
      hideChromium: !chromium,
      vendor: /Version\/[\d.]+ Safari\//.test(ua) ? 'Apple Computer, Inc.' : chromium ? 'Google Inc.' : '',
      blockWidevine: !widevine,
      askForWidevine: !widevine && widevinePrompt,
      globalPrivacyControl,
      fingerprintSeed: blockFingerprinting && siteUrl && protects(siteUrl) ? fingerprintSeed(siteUrl) : null,
      brand: chromium
        ? {
            name: / Edg\//.test(ua) ? 'Microsoft Edge' : 'Google Chrome',
            major: /Chrome\/(\d+)/.exec(ua)?.[1] ?? process.versions.chrome.split('.')[0],
            full: process.versions.chrome
          }
        : null,
      passkeys: topLevel && /^https:|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(pageUrl)
    }
    event.returnValue = config
  })
}
