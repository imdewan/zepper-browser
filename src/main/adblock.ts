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
import type { Protection } from '@shared/settings'
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

/** Recent answers: every request asks for its page's site several times. */
const siteCache = new Map<string, string>()

function siteOf(url: string): string {
  const cached = siteCache.get(url)
  if (cached !== undefined) return cached
  const { domain, hostname } = parse(url)
  const site = domain || hostname || ''
  if (siteCache.size >= 512) siteCache.delete(siteCache.keys().next().value!)
  siteCache.set(url, site)
  return site
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
  /** uBlock Origin's ad and tracker lists. */
  private base: ElectronBlocker | null = null
  /** The same plus the annoyance lists (cookie banners), loaded while that's turned on. */
  private full: ElectronBlocker | null = null
  private enabled = true
  /** Also hide cookie banners and other annoyances (uBlock Origin's annoyance lists). */
  private annoyances = false
  private started = false
  /** The other protections (see shields.ts), each switchable in Settings › Privacy. */
  private protections = { httpsUpgrade: true, cleanLinks: true, crossSiteCookies: true }
  readonly https = new HttpsUpgrades()
  /** Registrable domains where every protection is off. */
  private allowlist = new Set<string>()
  /** Registrable domains where some protections are off. */
  private exceptions: Record<string, Protection[]> = {}
  private readonly sessions = new Set<Session>()

  constructor(private readonly onBlocked: (webContentsId: number) => void) {
    ipcMain.on(COSMETICS_CHANNEL, (event, url: string) => {
      const page = topUrlOf(event.senderFrame, url)
      event.returnValue = this.blocksOn(page) ? this.cosmetics(url, page) : { styles: '', scripts: [] }
    })
    ipcMain.handle(COSMETICS_DOM_CHANNEL, (event, payload: { url: string; classes: string[]; ids: string[]; hrefs: string[] }) => {
      // Pages shape what the preload sends (class names, links), so it's bounded here too.
      const list = (value: unknown): string[] =>
        Array.isArray(value) ? value.slice(0, MAX_DOM_TOKENS).filter((v): v is string => typeof v === 'string' && v.length <= 512) : []
      const url = String(payload?.url ?? '')
      const tokens = { url, classes: list(payload?.classes), ids: list(payload?.ids), hrefs: list(payload?.hrefs) }
      const page = topUrlOf(event.senderFrame, url)
      return this.blocksOn(page) ? this.domCosmetics(tokens, page) : { styles: '', scripts: [] }
    })
  }

  private cachePath(full: boolean): string {
    return join(app.getPath('userData'), full ? 'adblock-engine-full.bin' : 'adblock-engine.bin')
  }

  async start(): Promise<void> {
    this.started = true
    this.base ??= await this.load(false)
    if (this.annoyances && !this.full) this.full = await this.load(true)
  }

  /** Loads an engine from its cache (refreshed daily) or the prebuilt lists. */
  private async load(full: boolean): Promise<ElectronBlocker | null> {
    const path = this.cachePath(full)
    if (await this.cacheIsStale(path)) await unlink(path).catch(() => {})
    try {
      const cache = {
        path,
        read: async (file: string) => new Uint8Array(await readFile(file)),
        write: (file: string, buffer: Uint8Array) => writeFile(file, buffer)
      }
      const blocker = full
        ? await ElectronBlocker.fromPrebuiltFull(fetch, cache)
        : await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, cache)
      blocker.on('request-blocked', (request) => this.onBlocked(request.tabId))
      return blocker
    } catch (error) {
      console.error('[adblock] failed to load filter lists', error)
      return null
    }
  }

  /** The engine for a page: with the annoyance lists, unless cookie banners are allowed there. */
  private blockerFor(pageUrl: string | undefined): ElectronBlocker | null {
    if (this.annoyances && this.full && this.protects(pageUrl, 'cookieBanners')) return this.full
    return this.base
  }

  /** When the filter lists on disk were last downloaded (0 if never). */
  async filtersUpdatedAt(): Promise<number> {
    try {
      return (await stat(this.cachePath(false))).mtimeMs
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
    if (!on) this.full = null
    else if (this.started)
      void this.load(true).then((blocker) => {
        if (this.annoyances) this.full = blocker
      })
  }

  setProtections(protections: { httpsUpgrade: boolean; cleanLinks: boolean; crossSiteCookies: boolean }): void {
    this.protections = protections
  }

  /** Whether a request mustn't send or receive cookies: a third party on a page with protections on. */
  crossSiteCookiesBlocked(details: RequestDetails): boolean {
    if (!this.protections.crossSiteCookies || details.resourceType === 'mainFrame') return false
    const page = pageUrlOf(details)
    if (!page || !/^https?:/.test(page) || !this.protects(page, 'crossSiteCookies')) return false
    const site = siteOf(details.url)
    if (!site || site === siteOf(page)) return false
    try {
      return !SIGN_IN_FRAMES.has(new URL(details.url).hostname)
    } catch {
      return false
    }
  }

  /** Sites where every protection is off, and sites where only some are. */
  setAllowlist(domains: string[], exceptions: Record<string, Protection[]> = {}): void {
    this.allowlist = new Set(domains)
    this.exceptions = exceptions
  }

  /** Whether ad blocking applies to a page, by its top-level URL. */
  blocksOn(pageUrl: string | undefined): boolean {
    return this.enabled && this.protects(pageUrl, 'ads')
  }

  /** Whether a site's protections (or one of them) are on; they're turned off per site from the lock icon. */
  protects(pageUrl: string | undefined, protection?: Protection): boolean {
    if (!pageUrl) return true
    const site = siteOf(pageUrl)
    if (!site || this.allowlist.has(site)) return !site
    return !protection || !this.exceptions[site]?.includes(protection)
  }

  /** Blocks in another session too (e.g. a private window's). */
  attachSession(session: Session): void {
    if (this.sessions.has(session)) return
    this.sessions.add(session)
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, this.onBeforeRequest)
    session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, this.onHeadersReceived)
  }

  /** A private window's session is done with: let it go. */
  detachSession(session: Session): void {
    if (!this.sessions.delete(session)) return
    session.webRequest.onBeforeRequest(null)
    session.webRequest.onHeadersReceived(null)
  }

  private readonly onBeforeRequest = (details: OnBeforeRequestListenerDetails, callback: (response: CallbackResponse) => void): void => {
    if (details.resourceType === 'mainFrame' && details.method === 'GET') {
      // Pages open without click trackers or AMP wrappers, and over HTTPS when the site has it.
      const cleaned = this.protections.cleanLinks && this.protects(details.url, 'cleanLinks') ? cleanLink(details.url) : null
      const upgraded =
        this.protections.httpsUpgrade && this.protects(details.url, 'httpsUpgrade') ? this.https.upgrade(cleaned ?? details.url) : null
      if (upgraded || cleaned) return callback({ redirectURL: upgraded ?? cleaned! })
    }
    const page = pageUrlOf(details)
    const blocker = this.blockerFor(page)
    if (!blocker || !this.blocksOn(page)) return callback({})
    blocker.onBeforeRequest(details, callback)
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
    const page = pageUrlOf(details)
    const blocker = this.blockerFor(page)
    if (!blocker || !this.blocksOn(page)) return done({})
    blocker.onHeadersReceived(details, done)
  }

  /** Hostname-specific hiding rules, generic base rules and scriptlets for a page. */
  private cosmetics(url: string, pageUrl: string): CosmeticsResponse {
    const empty = { styles: '', scripts: [] }
    const blocker = this.blockerFor(pageUrl)
    if (!blocker || !this.enabled || !/^https?:/.test(url)) return empty
    const { hostname, domain } = parse(url)
    if (!hostname) return empty
    const result = blocker.getCosmeticsFilters({
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
  private domCosmetics(payload: { url: string; classes: string[]; ids: string[]; hrefs: string[] }, pageUrl: string): CosmeticsResponse {
    const empty = { styles: '', scripts: [] }
    const blocker = this.blockerFor(pageUrl)
    if (!blocker || !this.enabled) return empty
    const { hostname, domain } = parse(payload.url)
    if (!hostname) return empty
    const result = blocker.getCosmeticsFilters({
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

  private async cacheIsStale(path: string): Promise<boolean> {
    try {
      const info = await stat(path)
      return Date.now() - info.mtimeMs > REFRESH_AFTER_MS
    } catch {
      return false
    }
  }
}
