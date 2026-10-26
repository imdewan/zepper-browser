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

/**
 * Ghostery's copies of uBlock Origin's lists, EasyList and EasyPrivacy, kept current and prepared for
 * its engine (the ones in its GitHub repository, which the library reads, stopped updating).
 */
const CDN = 'https://cdn.ghostery.com/adblocker/resources'
const UBO = 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters'
const BRAVE = 'https://raw.githubusercontent.com/brave/adblock-lists/master'
const BRAVE_RESOURCES = 'https://raw.githubusercontent.com/brave/adblock-resources/master'

/** A list from Ghostery's CDN (by name; it must be there), or from where its authors publish it. */
type ListSource = { cdn: string } | { url: string }

/** uBlock Origin keeps each year's new filters in a file of its own; a year with none yet is skipped. */
const UBO_YEARS = Array.from({ length: new Date().getFullYear() - 2019 }, (_, i) => ({ cdn: `ublock-filters-${2020 + i}`, optional: true }))

/**
 * Brave's default lists, as Brave Shields has them (brave/adblock-resources, filter_lists/list_catalog.json):
 * uBlock Origin's and EasyList's ad lists with Brave's own fixes, the privacy lists, Brave's first-party
 * ads, and app promos.
 */
const LISTS: (ListSource & { optional?: boolean })[] = [
  { cdn: 'ublock-filters' },
  ...UBO_YEARS,
  { url: `${UBO}/filters-general.txt` },
  { cdn: 'ublock-badware' },
  { cdn: 'ublock-abuse' },
  { cdn: 'ublock-unbreak' },
  { cdn: 'ublock-quick-fixes' },
  { url: `${UBO}/ubo-link-shorteners.txt` },
  { cdn: 'easylist' },
  { url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-agh-online.txt' },
  { url: `${BRAVE}/brave-unbreak.txt` },
  { url: `${BRAVE}/brave-lists/brave-specific.txt` },
  { url: `${BRAVE}/brave-lists/brave-social.txt` },
  { url: `${BRAVE}/brave-lists/brave-unbreak.txt` },
  { url: `${BRAVE}/brave-lists/brave-sugarcoat.txt` },
  { cdn: 'easyprivacy' },
  { cdn: 'ublock-privacy' },
  { url: `${BRAVE}/brave-lists/brave-firstparty.txt` },
  { url: `${BRAVE}/brave-lists/brave-firstparty-regional.txt` },
  { url: 'https://secure.fanboy.co.nz/fanboy-mobile-notifications.txt' }
]

/** Brave's cookie notice blocker. */
const COOKIE_LISTS: ListSource[] = [
  { url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster_ubo.txt' },
  { cdn: 'ublock-annoyances-cookies' },
  { url: `${BRAVE}/brave-lists/brave-cookie-specific.txt` }
]

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return response.text()
}

/** The latest revision of something on Ghostery's CDN. */
async function fromCdn(name: string): Promise<string> {
  const { revisions } = JSON.parse(await fetchText(`${CDN}/${name}/metadata.json`)) as { revisions: string[] }
  return fetchText(`${CDN}/${name}/${revisions.at(-1)}/list.txt`)
}

/**
 * Every list's text. Ghostery's copies are what everything else rests on, so if one of them can't be
 * had, nothing is built (the last engine is kept); one of the others missing just goes without it.
 */
async function fetchLists(sources: (ListSource & { optional?: boolean })[]): Promise<string[]> {
  return Promise.all(
    sources.map(async (source) => {
      try {
        return 'cdn' in source ? await fromCdn(source.cdn) : await fetchText(source.url)
      } catch (error) {
        if ('cdn' in source && !source.optional) throw error
        if (!source.optional) console.warn('[adblock] skipped a filter list', error)
        return ''
      }
    })
  )
}

/**
 * uBlock Origin's scriptlets and redirects (Ghostery's current build of them), with Brave's own scripts
 * (its YouTube fixes among them), which take no arguments and so run as they are, as in Brave.
 */
async function fetchResources(): Promise<string> {
  const resources = JSON.parse(await fromCdn('ublock-resources-json')) as { redirects: unknown[] }
  try {
    const metadata = JSON.parse(await fetchText(`${BRAVE_RESOURCES}/metadata.json`)) as {
      name: string
      aliases?: string[]
      kind?: { mime?: string }
      resourcePath: string
    }[]
    const scripts = await Promise.all(
      metadata
        .filter((resource) => resource.kind?.mime === 'application/javascript')
        .map(async (resource) => {
          const body = await fetchText(`${BRAVE_RESOURCES}/resources/${resource.resourcePath}`)
          const aliases = [...(resource.aliases ?? []), ...[...body.matchAll(/^\/\/\/ alias (\S+)/gm)].map((m) => m[1])]
          return { name: resource.name, aliases, body, contentType: 'application/javascript' }
        })
    )
    resources.redirects.push(...scripts)
  } catch (error) {
    console.warn("[adblock] couldn't add Brave's scripts", error)
  }
  return JSON.stringify(resources)
}

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
 * Built-in ad and tracker blocking, as Brave Shields does it.
 *
 * - Network requests are matched by Ghostery's engine against Brave's default
 *   lists (see LISTS), refreshed daily.
 * - Cosmetic filters and scriptlets are handed to our page preload
 *   synchronously, so they apply at document start, before any page script
 *   runs. That is what defeats YouTube's player ads; the stock Electron
 *   integration injects them asynchronously, after the page has started.
 */
/** Most class names, ids or links looked up per request from a page. */
const MAX_DOM_TOKENS = 2000

export class AdBlock {
  /** Brave's ad and tracker lists. */
  private base: ElectronBlocker | null = null
  /** The same plus its cookie notice blocker, loaded while that's turned on. */
  private full: ElectronBlocker | null = null
  private enabled = true
  /** Also hide cookie banners (Brave's cookie notice blocker). */
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
    return join(app.getPath('userData'), full ? 'adblock-brave-cookies.bin' : 'adblock-brave.bin')
  }

  async start(): Promise<void> {
    this.started = true
    // The engines built from the lists Zepper had before Brave's.
    for (const old of ['adblock-engine.bin', 'adblock-engine-full.bin']) void unlink(join(app.getPath('userData'), old)).catch(() => {})
    this.base ??= await this.load(false)
    if (this.annoyances && !this.full) this.full = await this.load(true)
  }

  /**
   * An engine from its cache, or built from the lists when that's a day old (or from another version of
   * the engine). If they can't be had, the old one does until they can.
   */
  private async load(full: boolean): Promise<ElectronBlocker | null> {
    const path = this.cachePath(full)
    const cached = async (): Promise<ElectronBlocker | null> => {
      try {
        return ElectronBlocker.deserialize(new Uint8Array(await readFile(path)))
      } catch {
        return null
      }
    }
    let blocker = (await this.cacheIsStale(path)) ? null : await cached()
    if (!blocker) {
      try {
        const [lists, resources] = await Promise.all([fetchLists(full ? [...LISTS, ...COOKIE_LISTS] : LISTS), fetchResources()])
        blocker = ElectronBlocker.parse(lists.join('\n'))
        blocker.updateResources(resources, String(resources.length))
        await writeFile(path, blocker.serialize())
      } catch (error) {
        console.error('[adblock] failed to load filter lists', error)
        blocker = await cached()
      }
    }
    blocker?.on('request-blocked', (request) => this.onBlocked(request.tabId))
    return blocker
  }

  /** The engine for a page: with the cookie notice lists, unless cookie banners are allowed there. */
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
