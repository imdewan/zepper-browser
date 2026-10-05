import { ElectronBlocker } from '@ghostery/adblocker-electron'
import {
  app,
  ipcMain,
  type CallbackResponse,
  type HeadersReceivedResponse,
  type OnBeforeRequestListenerDetails,
  type OnHeadersReceivedListenerDetails,
  type Session,
  type WebFrameMain
} from 'electron'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'tldts-experimental'
import { HttpsUpgrades, cleanLink } from './shields'

const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

export const COSMETICS_CHANNEL = 'zepper:cosmetics'
export const COSMETICS_DOM_CHANNEL = 'zepper:cosmetics-dom'

export interface CosmeticsResponse {
  styles: string
  scripts: string[]
}

/** What every request hook gets: enough to tell which page a request belongs to. */
interface RequestDetails {
  url: string
  resourceType: string
  frame?: WebFrameMain | null
  webContents?: { getURL(): string } | null
}

/** Sign-in frames that need their cookies even when embedded on another site. */
const SIGN_IN_FRAMES = new Set(['accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com'])

function siteOf(url: string): string {
  const { domain, hostname } = parse(url)
  return domain || hostname || ''
}

/** The top-level page a request or frame belongs to; ad blocking is decided per site. */
function pageUrlOf(details: RequestDetails): string | undefined {
  if (details.resourceType === 'mainFrame') return details.url
  try {
    return details.frame?.top?.url || details.webContents?.getURL()
  } catch {
    // The frame went away mid-request.
    return undefined
  }
}

function topUrlOf(frame: WebFrameMain | null | undefined, fallback: string): string {
  try {
    return frame?.top?.url || fallback
  } catch {
    return fallback
  }
}

/**
 * Built-in ad and tracker blocking, uBlock Origin–style.
 *
 * - Network requests are matched by Ghostery's engine against uBlock Origin's
 *   default lists (EasyList, EasyPrivacy, Peter Lowe, uBO filters/badware/
 *   privacy/quick-fixes/unbreak).
 * - Cosmetic filters and scriptlets are handed to our page preload
 *   synchronously, so they apply at document start, before any page script
 *   runs. That is what defeats YouTube's player ads; the stock Electron
 *   integration injects them asynchronously, after the page has started.
 */
/** Most class names, ids or links looked up per request from a page. */
const MAX_DOM_TOKENS = 2000

export class AdBlock {
  private blocker: ElectronBlocker | null = null
  private enabled = true
  /** Also hide cookie banners and other annoyances (uBlock Origin's annoyance lists). */
  private annoyances = false
  private started = false
  /** The other protections (see shields.ts), each switchable in Settings › Privacy. */
  private protections = { httpsUpgrade: true, cleanLinks: true, crossSiteCookies: true }
  readonly https = new HttpsUpgrades()
  /** Registrable domains where blocking is off. */
  private allowlist = new Set<string>()
  private readonly sessions = new Set<Session>()

  constructor(private readonly onBlocked: (webContentsId: number) => void) {
    ipcMain.on(COSMETICS_CHANNEL, (event, url: string) => {
      event.returnValue = this.blocksOn(topUrlOf(event.senderFrame, url)) ? this.cosmetics(url) : { styles: '', scripts: [] }
    })
    ipcMain.handle(COSMETICS_DOM_CHANNEL, (event, payload: { url: string; classes: string[]; ids: string[]; hrefs: string[] }) => {
      // Pages shape what the preload sends (class names, links), so it's bounded here too.
      const list = (value: unknown): string[] =>
        Array.isArray(value) ? value.slice(0, MAX_DOM_TOKENS).filter((v): v is string => typeof v === 'string' && v.length <= 512) : []
      const url = String(payload?.url ?? '')
      const tokens = { url, classes: list(payload?.classes), ids: list(payload?.ids), hrefs: list(payload?.hrefs) }
      return this.blocksOn(topUrlOf(event.senderFrame, url)) ? this.domCosmetics(tokens) : { styles: '', scripts: [] }
    })
  }

  /** The engine for the current lists is cached separately from the other one's. */
  private get cachePath(): string {
    return join(app.getPath('userData'), this.annoyances ? 'adblock-engine-full.bin' : 'adblock-engine.bin')
  }

  async start(): Promise<void> {
    this.started = true
    const full = this.annoyances
    if (await this.cacheIsStale()) await unlink(this.cachePath).catch(() => {})
    try {
      const cache = {
        path: this.cachePath,
        read: async (path: string) => new Uint8Array(await readFile(path)),
        write: (path: string, buffer: Uint8Array) => writeFile(path, buffer)
      }
      const blocker = full
        ? await ElectronBlocker.fromPrebuiltFull(fetch, cache)
        : await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, cache)
      // A newer choice of lists may have arrived while these loaded.
      if (full !== this.annoyances) return
      blocker.on('request-blocked', (request) => this.onBlocked(request.tabId))
      this.blocker = blocker
    } catch (error) {
      console.error('[adblock] failed to load filter lists', error)
    }
  }

  /** When the filter lists on disk were last downloaded (0 if never). */
  async filtersUpdatedAt(): Promise<number> {
    try {
      return (await stat(this.cachePath)).mtimeMs
    } catch {
      return 0
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  /** Cookie banners and other annoyances: switches to the larger list set (loaded in the background). */
  setAnnoyances(on: boolean): void {
    if (on === this.annoyances) return
    this.annoyances = on
    if (this.started) void this.start()
  }

  setProtections(protections: { httpsUpgrade: boolean; cleanLinks: boolean; crossSiteCookies: boolean }): void {
    this.protections = protections
  }

  /** Whether a request mustn't send or receive cookies: a third party on a page with protections on. */
  crossSiteCookiesBlocked(details: RequestDetails): boolean {
    if (!this.protections.crossSiteCookies || details.resourceType === 'mainFrame') return false
    const page = pageUrlOf(details)
    if (!page || !/^https?:/.test(page) || !this.protects(page)) return false
    const site = siteOf(details.url)
    if (!site || site === siteOf(page)) return false
    try {
      return !SIGN_IN_FRAMES.has(new URL(details.url).hostname)
    } catch {
      return false
    }
  }

  /** Sites (registrable domains) where blocking is off. */
  setAllowlist(domains: string[]): void {
    this.allowlist = new Set(domains)
  }

  /** Whether ad blocking applies to a page, by its top-level URL. */
  blocksOn(pageUrl: string | undefined): boolean {
    return this.enabled && this.protects(pageUrl)
  }

  /** Whether a site's protections are on (they're off for sites in the allowlist, from the site panel). */
  protects(pageUrl: string | undefined): boolean {
    if (!pageUrl || this.allowlist.size === 0) return true
    const site = siteOf(pageUrl)
    return !site || !this.allowlist.has(site)
  }

  /** Blocks in another session too (e.g. a private window's). */
  attachSession(session: Session): void {
    if (this.sessions.has(session)) return
    this.sessions.add(session)
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, this.onBeforeRequest)
    session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, this.onHeadersReceived)
  }

  private readonly onBeforeRequest = (details: OnBeforeRequestListenerDetails, callback: (response: CallbackResponse) => void): void => {
    if (details.resourceType === 'mainFrame' && details.method === 'GET') {
      // Pages open without click trackers or AMP wrappers, and over HTTPS when the site has it.
      const cleaned = this.protections.cleanLinks && this.protects(details.url) ? cleanLink(details.url) : null
      const upgraded = this.protections.httpsUpgrade ? this.https.upgrade(cleaned ?? details.url) : null
      if (upgraded || cleaned) return callback({ redirectURL: upgraded ?? cleaned! })
    }
    if (!this.blocker || !this.blocksOn(pageUrlOf(details))) return callback({})
    this.blocker.onBeforeRequest(details, callback)
  }

  private readonly onHeadersReceived = (
    details: OnHeadersReceivedListenerDetails,
    callback: (response: HeadersReceivedResponse) => void
  ): void => {
    // Third parties can't set cookies (the request side is in Hub's onBeforeSendHeaders).
    const noCookies = this.crossSiteCookiesBlocked(details)
    const done = (response: HeadersReceivedResponse): void => {
      if (!noCookies) return callback(response)
      const headers = { ...(response.responseHeaders ?? details.responseHeaders ?? {}) }
      for (const key of Object.keys(headers)) if (key.toLowerCase() === 'set-cookie') delete headers[key]
      callback({ ...response, responseHeaders: headers })
    }
    if (!this.blocker || !this.blocksOn(pageUrlOf(details))) return done({})
    this.blocker.onHeadersReceived(details, done)
  }

  /** Hostname-specific hiding rules, generic base rules and scriptlets for a page. */
  private cosmetics(url: string): CosmeticsResponse {
    const empty = { styles: '', scripts: [] }
    if (!this.blocker || !this.enabled || !/^https?:/.test(url)) return empty
    const { hostname, domain } = parse(url)
    if (!hostname) return empty
    const result = this.blocker.getCosmeticsFilters({
      url,
      hostname,
      domain,
      getBaseRules: true,
      getInjectionRules: true,
      getExtendedRules: false,
      getRulesFromHostname: true,
      getRulesFromDOM: false
    })
    return { styles: result.styles, scripts: result.scripts }
  }

  /** Generic class/id/href hiding rules for what the page actually contains. */
  private domCosmetics(payload: { url: string; classes: string[]; ids: string[]; hrefs: string[] }): CosmeticsResponse {
    const empty = { styles: '', scripts: [] }
    if (!this.blocker || !this.enabled) return empty
    const { hostname, domain } = parse(payload.url)
    if (!hostname) return empty
    const result = this.blocker.getCosmeticsFilters({
      url: payload.url,
      hostname,
      domain,
      classes: payload.classes,
      ids: payload.ids,
      hrefs: payload.hrefs,
      getBaseRules: false,
      getInjectionRules: false,
      getExtendedRules: false,
      getRulesFromHostname: false,
      getRulesFromDOM: true
    })
    return { styles: result.styles, scripts: [] }
  }

  private async cacheIsStale(): Promise<boolean> {
    try {
      const info = await stat(this.cachePath)
      return Date.now() - info.mtimeMs > REFRESH_AFTER_MS
    } catch {
      return false
    }
  }
}
