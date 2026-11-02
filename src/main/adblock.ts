import { ElectronBlocker, FiltersEngine, fromElectronDetails } from '@ghostery/adblocker-electron'
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
import { randomBytes } from 'node:crypto'
import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'tldts-experimental'
import type { Protection } from '@shared/settings'
import { HttpsUpgrades, cleanLink } from './shields'

/** As uBlock Origin's quick fixes, where its YouTube rules are, expire. */
const REFRESH_AFTER_MS = 8 * 60 * 60 * 1000
/** How often a running Zepper (it can stay open for days) looks whether its lists are due. */
const CHECK_EVERY_MS = 60 * 60 * 1000

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

/** Brave's first-party ads and app promos: the default lists Brave lets block a site's requests to itself. */
const FIRST_PARTY_LISTS: ListSource[] = [
  { url: `${BRAVE}/brave-lists/brave-firstparty.txt` },
  { url: `${BRAVE}/brave-lists/brave-firstparty-regional.txt` },
  { url: 'https://secure.fanboy.co.nz/fanboy-mobile-notifications.txt' }
]

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
  ...FIRST_PARTY_LISTS
]

/** Brave's cookie notice blocker. */
const COOKIE_LISTS: ListSource[] = [
  { url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster_ubo.txt' },
  { cdn: 'ublock-annoyances-cookies' },
  { url: `${BRAVE}/brave-lists/brave-cookie-specific.txt` }
]

/**
 * Each engine Zepper keeps, and its lists. A site's requests to itself only go through the first-party
 * ones, as in Brave's Standard mode: Brave's first-party ads and app promos, and the cookie notice
 * blocker.
 */
type EngineKind = 'base' | 'full' | 'firstParty' | 'firstPartyFull'
/** Raised when what goes into an engine changes, so the ones saved before are built again. */
const ENGINE_REVISION = 2
const ENGINES: Record<EngineKind, { lists: (ListSource & { optional?: boolean })[]; file: string }> = {
  base: { lists: LISTS, file: `adblock-r${ENGINE_REVISION}.bin` },
  full: { lists: [...LISTS, ...COOKIE_LISTS], file: `adblock-r${ENGINE_REVISION}-cookies.bin` },
  firstParty: { lists: FIRST_PARTY_LISTS, file: `adblock-r${ENGINE_REVISION}-1p.bin` },
  firstPartyFull: { lists: [...FIRST_PARTY_LISTS, ...COOKIE_LISTS], file: `adblock-r${ENGINE_REVISION}-1p-cookies.bin` }
}

/**
 * Sites whose requests to themselves go through every list, as with uBlock Origin, not just the first-party
 * ones: YouTube's rules are written for uBlock Origin, which blocks YouTube's own ad and tracking requests
 * (its ad breaks, ad pings, log_event).
 */
const FULL_BLOCKING_SITES = new Set(['youtube.com', 'youtube-nocookie.com'])

/** Downloads under way or just done: engines built one after another share their lists. */
const downloads = new Map<string, Promise<string>>()
const DOWNLOADS_SHARED_MS = 5 * 60 * 1000

function fetchText(url: string): Promise<string> {
  let download = downloads.get(url)
  if (!download) {
    download = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`${url}: ${response.status}`)
      return response.text()
    })
    downloads.set(url, download)
    setTimeout(() => downloads.delete(url), DOWNLOADS_SHARED_MS).unref()
  }
  return download
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
 * Brave's scripts for Brave itself: hiding that it's Brave (from sites that turn it away), its background
 * play, and its fixes on YouTube for its own storage and timers. Zepper isn't Brave, and on YouTube they
 * rewrite what the page checks the browser by (performance.now, navigator.userAgentData), which uBlock
 * Origin leaves alone; with them, YouTube took Zepper for an ad blocker and stopped its videos.
 */
const BRAVE_ONLY_SCRIPTS = new Set([
  'brave-fix.js',
  'brave-video-bg-play.js',
  'brave-video-bg-play-update.js',
  'brave-youtube-navigation-fix.js',
  'brave-youtube-playback-speed-fix.js',
  'brave-youtube-theater-fix.js'
])

/**
 * uBlock Origin's scriptlets and redirects (Ghostery's current build of them), with Brave's own scripts
 * (but those only Brave needs, see BRAVE_ONLY_SCRIPTS), which take no arguments and so run as they are,
 * as in Brave.
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
        .filter((resource) => resource.kind?.mime === 'application/javascript' && !BRAVE_ONLY_SCRIPTS.has(resource.name))
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

const METHODS = ['CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']
/** A network rule's `method=` option (as the last of its options or not), e.g. `$xhr,method=get|post`. */
const METHOD_OPTION = /^([^#]*?\$(?:[^$]*,)?)method=([~a-z|]+)(,[^$]*)?$/i

/**
 * The rules for some request methods only (`method=`, which uBlock Origin's YouTube rules use), taken
 * out of the lists: Ghostery's engine can't read the option and drops the whole rule.
 */
function splitMethodRules(text: string): { text: string; methodRules: string[] } {
  const methodRules: string[] = []
  const rest = text.split('\n').filter((line) => {
    if (line.startsWith('!') || !line.includes('method=') || !METHOD_OPTION.test(line)) return true
    methodRules.push(line)
    return false
  })
  return { text: rest.join('\n'), methodRules }
}

/** Each request method's own engine, of the rules for it with the option taken off. */
function compileMethodRules(methodRules: string[]): Map<string, FiltersEngine> {
  const byMethod = new Map<string, string[]>()
  for (const rule of methodRules) {
    const [, head, spec, tail = ''] = METHOD_OPTION.exec(rule) ?? []
    if (!head || !spec) continue
    const listed = spec.toUpperCase().split('|')
    const negated = listed.filter((m) => m.startsWith('~')).map((m) => m.slice(1))
    const methods = negated.length > 0 ? METHODS.filter((m) => !negated.includes(m)) : listed.filter((m) => METHODS.includes(m))
    // `$method=get` alone leaves `$`; `$xhr,method=get` leaves `$xhr,`.
    const stripped = (head + tail.slice(1)).replace(/[$,]$/, '')
    for (const method of methods) byMethod.set(method, [...(byMethod.get(method) ?? []), stripped])
  }
  return new Map([...byMethod].map(([method, rules]) => [method, FiltersEngine.parse(rules.join('\n'))]))
}

/** An engine, with its rules for some request methods only. */
interface Engine {
  blocker: ElectronBlocker
  byMethod: Map<string, FiltersEngine>
}

/** Where the ad blocker's stand-ins for what it blocks are served from (see AdBlock.resourceUrl). */
export const RESOURCE_SCHEME = 'zepper-resource'

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

/**
 * Whether a request is to the site that made it (Brave's SameDomainOrHost, against the frame making
 * it; for a frame, the page it's in), and so only goes through the first-party lists. A page itself
 * loading never is, nor are YouTube's requests (see FULL_BLOCKING_SITES).
 */
function isFirstParty(details: RequestDetails): boolean {
  if (details.resourceType === 'mainFrame') return false
  let initiator: string | undefined
  try {
    initiator = (details.resourceType === 'subFrame' ? details.frame?.parent : details.frame)?.url
  } catch {
    // The frame went away mid-request.
  }
  initiator ||= pageUrlOf(details)
  const site = siteOf(details.url)
  return !!initiator && !!site && site === siteOf(initiator) && !FULL_BLOCKING_SITES.has(site)
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
 *   lists (see LISTS), refreshed every 8 hours, while Zepper's open too. As in
 *   Brave's Standard mode, a site's requests to itself only go through the
 *   first-party ones (see ENGINES), YouTube's apart (see FULL_BLOCKING_SITES).
 *   What's blocked with a stand-in gets it from
 *   Zepper (see resourceUrl), as from uBlock Origin or Brave.
 * - Cosmetic filters and scriptlets are handed to our page preload
 *   synchronously, so they apply at document start, before any page script
 *   runs. That is what defeats YouTube's player ads; the stock Electron
 *   integration injects them asynchronously, after the page has started.
 */
/** Most class names, ids or links looked up per request from a page. */
const MAX_DOM_TOKENS = 2000

export class AdBlock {
  /**
   * The engines in use (see ENGINES): the ones with the cookie notice blocker are loaded while that's
   * turned on.
   */
  private engines: Partial<Record<EngineKind, Engine | null>> = {}
  /** The stand-ins handed out (see resourceUrl), by name. */
  private readonly resources = new Map<string, { type: string; body: Buffer }>()
  /** In each stand-in's address, so a page can't look for Zepper's without having been given one. */
  private readonly resourceSecret = randomBytes(8).toString('hex')
  private enabled = true
  /** Also hide cookie banners (Brave's cookie notice blocker). */
  private annoyances = false
  private started = false
  private refreshing = false
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

  private cachePath(kind: EngineKind): string {
    return join(app.getPath('userData'), ENGINES[kind].file)
  }

  /** The engines needed now: the cookie notice blocker's only while it's turned on. */
  private kinds(): EngineKind[] {
    return this.annoyances ? ['base', 'firstParty', 'full', 'firstPartyFull'] : ['base', 'firstParty']
  }

  async start(): Promise<void> {
    this.started = true
    // The engines an earlier Zepper saved (see ENGINE_REVISION).
    const current = new Set(Object.values(ENGINES).map((engine) => engine.file))
    void readdir(app.getPath('userData'))
      .then((names) => {
        for (const name of names) {
          if (/^adblock-.*\.bin$/.test(name) && !current.has(name)) void unlink(join(app.getPath('userData'), name)).catch(() => {})
        }
      })
      .catch(() => {})
    for (const kind of this.kinds()) this.engines[kind] ??= await this.load(kind)
    setInterval(() => void this.refresh(), CHECK_EVERY_MS).unref()
  }

  /**
   * An engine from its cache, or built from the lists when they're due (or the cache is from another
   * version of the engine). If they can't be had, the old one does until they can.
   */
  private async load(kind: EngineKind): Promise<Engine | null> {
    if (!(await this.cacheIsStale(this.cachePath(kind)))) {
      const engine = await this.cached(kind)
      if (engine) return engine
    }
    return (await this.build(kind)) ?? (await this.cached(kind))
  }

  /**
   * Newer lists while Zepper stays open: YouTube's rules change every few days, and a page that's
   * missing one can be told it has an ad blocker. Each engine in use is swapped once its lists are
   * due; if they can't be had, it's kept and tried again next time.
   */
  private async refresh(): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    try {
      for (const kind of this.kinds()) {
        if (!(await this.cacheIsStale(this.cachePath(kind)))) continue
        const engine = await this.build(kind)
        // Unless cookie banners were allowed again meanwhile.
        if (engine && this.kinds().includes(kind)) this.engines[kind] = engine
      }
    } finally {
      this.refreshing = false
    }
  }

  /**
   * The engine saved last time: its rules for some request methods (their length first), then Ghostery's
   * serialized engine. One saved another way (by an earlier Zepper, or another version of the engine)
   * doesn't read, and is built again.
   */
  private async cached(kind: EngineKind): Promise<Engine | null> {
    try {
      const file = await readFile(this.cachePath(kind))
      const length = file.readUInt32LE(0)
      const methodRules = JSON.parse(file.subarray(4, 4 + length).toString()) as string[]
      return this.engine(ElectronBlocker.deserialize(new Uint8Array(file.subarray(4 + length))), methodRules)
    } catch {
      return null
    }
  }

  /** An engine from the lists as they are now, saved for next time (null if they can't be had). */
  private async build(kind: EngineKind): Promise<Engine | null> {
    try {
      const [lists, resources] = await Promise.all([fetchLists(ENGINES[kind].lists), fetchResources()])
      const { text, methodRules } = splitMethodRules(lists.join('\n'))
      const blocker = ElectronBlocker.parse(text)
      blocker.updateResources(resources, String(resources.length))
      const header = Buffer.from(JSON.stringify(methodRules))
      const length = Buffer.alloc(4)
      length.writeUInt32LE(header.length)
      await writeFile(this.cachePath(kind), Buffer.concat([length, header, blocker.serialize()]))
      return this.engine(blocker, methodRules)
    } catch (error) {
      console.error('[adblock] failed to load filter lists', error)
      return null
    }
  }

  /** An engine ready for use: its rules for some methods compiled, and what it blocks counted on its tab. */
  private engine(blocker: ElectronBlocker, methodRules: string[]): Engine {
    blocker.on('request-blocked', (request) => this.onBlocked(request.tabId))
    return { blocker, byMethod: compileMethodRules(methodRules) }
  }

  /**
   * The engine for a page (or for its requests to its own site): with the cookie notice lists, unless
   * cookie banners are allowed there.
   */
  private engineFor(pageUrl: string | undefined, firstParty = false): Engine | null {
    const cookies = this.annoyances && this.protects(pageUrl, 'cookieBanners')
    const plain = this.engines[firstParty ? 'firstParty' : 'base'] ?? null
    return (cookies && this.engines[firstParty ? 'firstPartyFull' : 'full']) || plain
  }

  /** When the filter lists on disk were last downloaded (0 if never). */
  async filtersUpdatedAt(): Promise<number> {
    try {
      return (await stat(this.cachePath('base'))).mtimeMs
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
    const kinds = ['full', 'firstPartyFull'] as const
    if (!on) for (const kind of kinds) delete this.engines[kind]
    else if (this.started)
      for (const kind of kinds)
        void this.load(kind).then((engine) => {
          if (this.annoyances) this.engines[kind] = engine
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
    session.protocol.handle(RESOURCE_SCHEME, this.serveResource)
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, this.onBeforeRequest)
    session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, this.onHeadersReceived)
  }

  /** A private window's session is done with: let it go. */
  detachSession(session: Session): void {
    if (!this.sessions.delete(session)) return
    session.protocol.unhandle(RESOURCE_SCHEME)
    session.webRequest.onBeforeRequest(null)
    session.webRequest.onHeadersReceived(null)
  }

  /**
   * Where a stand-in is served. Ghostery's engine hands it out as a data: URL, and Chromium won't send
   * a page's request there (ERR_UNSAFE_REDIRECT), so the page saw it fail where uBlock Origin and
   * Brave give it the stand-in: on YouTube, the ad_status.js it checks for an ad blocker with.
   */
  private resourceUrl(redirect: { filename: string; body: string; contentType: string }): string {
    const name = encodeURIComponent(redirect.filename)
    if (!this.resources.has(name)) {
      // Binary ones (images, media) come base64-encoded, and say so in their type.
      const base64 = redirect.contentType.endsWith(';base64')
      this.resources.set(name, {
        type: base64 ? redirect.contentType.slice(0, -';base64'.length) : redirect.contentType,
        body: Buffer.from(redirect.body, base64 ? 'base64' : 'utf8')
      })
    }
    return `${RESOURCE_SCHEME}://stand-in/${name}?${this.resourceSecret}`
  }

  private readonly serveResource = (request: Request): Response => {
    const url = new URL(request.url)
    const resource = url.search === `?${this.resourceSecret}` ? this.resources.get(url.pathname.slice(1)) : undefined
    if (!resource) return new Response(null, { status: 404 })
    // Fetched across sites (a page's request for an ad script, sent here): allowed, with its cookies.
    const origin = request.headers.get('origin')
    const cors: Record<string, string> = origin ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' } : {}
    return new Response(new Uint8Array(resource.body), { headers: { 'content-type': resource.type, ...cors } })
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
    const engine = this.engineFor(page, isFirstParty(details))
    if (!engine || !this.blocksOn(page) || details.resourceType === 'mainFrame') return callback({})
    const request = fromElectronDetails(details)
    const { redirect, match, exception } = engine.blocker.match(request)
    if (redirect) return callback({ redirectURL: this.resourceUrl(redirect) })
    if (match) return callback({ cancel: true })
    // The rules for this method only, unless the lists made an exception for the request.
    if (exception || !engine.byMethod.get(details.method)?.match(request).match) return callback({})
    if (details.webContentsId !== undefined) this.onBlocked(details.webContentsId)
    callback({ cancel: true })
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
    const blocker = this.engineFor(page)?.blocker
    if (!blocker || !this.blocksOn(page)) return done({})
    blocker.onHeadersReceived(details, done)
  }

  /** Hostname-specific hiding rules, generic base rules and scriptlets for a page. */
  private cosmetics(url: string, pageUrl: string): CosmeticsResponse {
    const empty = { styles: '', scripts: [] }
    const blocker = this.engineFor(pageUrl)?.blocker
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
    const blocker = this.engineFor(pageUrl)?.blocker
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

  /** Whether the lists are due: saved too long ago, or never (a first download that failed is retried). */
  private async cacheIsStale(path: string): Promise<boolean> {
    try {
      const info = await stat(path)
      return Date.now() - info.mtimeMs > REFRESH_AFTER_MS
    } catch {
      return true
    }
  }
}
