import { app, session, type BrowserWindow, type Extension, type Session, type WebContents } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { ElectronChromeExtensions, setSessionPartitionResolver } from 'electron-chrome-extensions'
import { installChromeWebStore, uninstallExtension } from 'electron-chrome-web-store'
import type { ExtensionInfo } from '@shared/types'
import type { SettingsStore } from './settings-store'

/** Partition name the browser UI uses to reach the browsing session's extensions. */
export const BROWSING_PARTITION = 'zepper-browsing'

export interface ExtensionHost {
  window(): BrowserWindow
  createTab(url: string, active: boolean): WebContents
  selectTab(webContents: WebContents): void
  removeTab(webContents: WebContents): void
}

/**
 * Chrome extension support: installing from the Chrome Web Store (and auto-updating), plus the
 * chrome.tabs / windows / action / contextMenus APIs that Electron doesn't provide on its own.
 *
 * Extensions are installed once and run in every space: each browsing session (the main profile,
 * and every space with its own sign-ins) gets the extension APIs and every installed extension,
 * with its own extension storage, like its own cookies. The Web Store works from any of them.
 */
export class Extensions {
  private readonly contexts = new Map<Session, ElectronChromeExtensions>()
  /** Extensions that may reach a page only once you use them on it (activeTab): the sites they reach regardless. */
  private readonly limited = new Map<string, string[]>()
  /** …and the tabs you've used each on, with the site the tab was on then. */
  private readonly granted = new Map<string, Map<WebContents, string>>()
  private settings: SettingsStore | null = null
  private started = false

  constructor(
    private readonly host: ExtensionHost,
    uiSession: Session
  ) {
    setSessionPartitionResolver((partition) =>
      partition === BROWSING_PARTITION ? session.defaultSession : session.fromPartition(partition)
    )
    this.attach(session.defaultSession)
    // Extension icons in the browser UI are served over crx:// from the UI's own session.
    ElectronChromeExtensions.handleCRXProtocol(uiSession)
  }

  /** A browsing session gets the extension APIs, the Web Store, and every installed extension. */
  attach(ses: Session): void {
    if (this.contexts.has(ses)) return
    const host = this.host
    const context = new ElectronChromeExtensions({
      license: 'GPL-3.0',
      session: ses,
      createTab: async (details) => [host.createTab(details.url ?? 'about:blank', details.active !== false), host.window()],
      selectTab: (webContents) => host.selectTab(webContents),
      removeTab: (webContents) => host.removeTab(webContents),
      createWindow: async (details) => {
        const urls = details.url ? ([] as string[]).concat(details.url) : []
        for (const url of urls) host.createTab(url, true)
        return host.window()
      },
      removeWindow: () => {}
    })
    // A link in an extension's popup opens in a new tab, as in Chrome, and the popup closes (one opened in
    // the background leaves it open). Otherwise it would get a bare window of its own.
    context.on('browser-action-popup-created', (popup: { browserWindow?: BrowserWindow; destroy(): void }) => {
      popup.browserWindow?.webContents.setWindowOpenHandler(({ url, disposition }) => {
        const background = disposition === 'background-tab'
        if (/^(https?|chrome-extension):/.test(url)) host.createTab(url, !background)
        if (!background) popup.destroy()
        return { action: 'deny' }
      })
    })
    this.contexts.set(ses, context)
    useExtensionApiPreload(ses)
    // An extension's files are adjusted before it loads (see prepareFiles), so it loads once, as it is
    // meant to run here: loading it again would tell it it had just been installed.
    const { extensions } = ses
    const load = extensions.loadExtension.bind(extensions)
    extensions.loadExtension = (path, options) => {
      prepareFiles(path)
      return load(path, options)
    }
    this.addApis(context)
    ses.extensions.on('extension-loaded', (_event, extension) => {
      // Loaded some other way, before its files were adjusted: once more, with them.
      if (prepareFiles(extension.path)) return this.reload(extension)
      this.noteSiteAccess(extension)
      // Installed from this session's Web Store: every other session gets it too.
      this.spread(extension)
    })
    if (this.started) void this.prepare(ses)
  }

  /**
   * Chrome's activeTab: using an extension on a page (its toolbar button, or its item in the page's
   * menu) lets it reach that page until the tab goes to another site. Electron can't give an extension
   * a site while it runs, so these extensions are given every site when they load (see patchSiteAccess)
   * and Zepper holds them to the pages you've used them on: running scripts and taking pictures there
   * (checked here and in the API preload), and sending your cookies only to their own sites.
   */
  private noteSiteAccess(extension: Extension): void {
    const patterns = readSiteAccess(extension.path)
    if (patterns) this.limited.set(extension.id, patterns)
    else this.limited.delete(extension.id)
  }

  private grant(extensionId: string, tab: WebContents | undefined): void {
    if (!tab || tab.isDestroyed() || !this.limited.has(extensionId)) return
    let tabs = this.granted.get(extensionId)
    if (!tabs) this.granted.set(extensionId, (tabs = new Map()))
    if (!tabs.has(tab)) tab.once('destroyed', () => tabs.delete(tab))
    tabs.set(tab, originOf(tab.getURL()))
  }

  /** Whether an extension may reach the page a tab shows (any extension Zepper doesn't hold back may). */
  private reaches(extensionId: string, tab: WebContents | undefined): boolean {
    const patterns = this.limited.get(extensionId)
    if (!patterns) return true
    if (!tab || tab.isDestroyed()) return false
    const url = tab.getURL()
    // Its own pages, and the sites it asked for.
    if (url.startsWith(`chrome-extension://${extensionId}/`) || patterns.some((pattern) => matchesPattern(pattern, url))) return true
    const origin = this.granted.get(extensionId)?.get(tab)
    return origin !== undefined && origin === originOf(url)
  }

  /** A request from an extension carries your cookies only to sites it may reach (see noteSiteAccess). */
  sendsCookies(initiator: string | undefined, url: string): boolean {
    const id = /^chrome-extension:\/\/([a-p]{32})/.exec(initiator ?? '')?.[1]
    const patterns = id ? this.limited.get(id) : undefined
    if (!id || !patterns) return true
    if (patterns.some((pattern) => matchesPattern(pattern, url))) return true
    const origin = originOf(url)
    for (const [tab, granted] of this.granted.get(id) ?? []) if (granted === origin && originOf(tab.getURL()) === origin) return true
    return false
  }

  /** chrome.tabs methods the library leaves out, and the check behind the activeTab preload. */
  private addApis(context: ElectronChromeExtensions): void {
    const internals = context as unknown as ExtensionsInternals
    const { router, store } = internals.ctx
    const { api } = internals
    // Using an extension on a page lets it reach the page.
    const activateClick = api.browserAction.activateClick.bind(api.browserAction)
    api.browserAction.activateClick = (details) => {
      this.grant(details.extensionId, details.tabId >= 0 ? store.getTabById(details.tabId) : store.getActiveTabOfCurrentWindow())
      return activateClick(details)
    }
    const menuClicked = api.contextMenus.onClicked.bind(api.contextMenus)
    api.contextMenus.onClicked = (extensionId, menuItemId, tab, params) => {
      this.grant(extensionId, tab)
      return menuClicked(extensionId, menuItemId, tab, params)
    }
    const handle = router.apiHandler()
    handle('zepper.siteAccess', (event, query?: unknown) => {
      const id = (event as RouterEvent).extension?.id
      const patterns = id ? this.limited.get(id) : undefined
      if (!id || !patterns) return true
      const { tabId, matches } = (query ?? {}) as { tabId?: unknown; matches?: unknown }
      if (Array.isArray(matches)) return matches.every((match) => patterns.includes(String(match)))
      return this.reaches(id, typeof tabId === 'number' ? store.getTabById(tabId) : undefined)
    })
    handle('tabs.captureVisibleTab', async (event, windowOrOptions?: unknown, maybeOptions?: unknown) => {
      // (windowId?, options?), or just (options).
      const [windowId, options] =
        windowOrOptions && typeof windowOrOptions === 'object' ? [undefined, windowOrOptions] : [windowOrOptions, maybeOptions]
      const id = typeof windowId === 'number' && windowId !== WINDOW_ID_CURRENT ? windowId : store.lastFocusedWindowId
      const win = id === undefined ? undefined : store.getWindowById(id)
      const tab = win && store.getActiveTabFromWindow(win)
      if (!tab || tab.isDestroyed()) throw new Error('No active tab to capture.')
      const extensionId = (event as RouterEvent).extension?.id
      if (extensionId && !this.reaches(extensionId, tab)) throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.")
      const image = await tab.capturePage()
      const { format, quality } = (options ?? {}) as { format?: string; quality?: number }
      return format === 'png'
        ? `data:image/png;base64,${image.toPNG().toString('base64')}`
        : `data:image/jpeg;base64,${image.toJPEG(typeof quality === 'number' ? Math.max(0, Math.min(100, quality)) : 92).toString('base64')}`
    })
    handle('tabs.detectLanguage', async (_event, tabId?: unknown) => {
      const win = store.lastFocusedWindowId === undefined ? undefined : store.getWindowById(store.lastFocusedWindowId)
      const tab = typeof tabId === 'number' ? store.getTabById(tabId) : win && store.getActiveTabFromWindow(win)
      if (!tab || tab.isDestroyed()) return 'und'
      const lang = await tab.executeJavaScript('document.documentElement.lang', false).catch(() => '')
      return typeof lang === 'string' && lang ? lang.split(/[-_]/)[0].toLowerCase() : 'und'
    })
  }

  /** The extension APIs for a page's session (none in private windows). */
  apiFor(ses: Session): ElectronChromeExtensions | undefined {
    return this.contexts.get(ses)
  }

  /** Enables Web Store installs and loads previously installed extensions (except ones you turned off). */
  async start(settings: SettingsStore): Promise<void> {
    this.settings = settings
    this.started = true
    for (const ses of this.contexts.keys()) await this.prepare(ses)
  }

  private async prepare(ses: Session): Promise<void> {
    try {
      await installChromeWebStore({ session: ses })
    } catch (error) {
      console.error('[extensions] failed to start the Chrome Web Store integration', error)
    }
    for (const off of this.settings?.get().disabledExtensions ?? []) {
      if (ses.extensions.getExtension(off.id)) ses.extensions.removeExtension(off.id)
    }
  }

  /** Loads an extension again everywhere it's loaded (after its files changed). */
  private reload(extension: Extension): void {
    for (const ses of this.contexts.keys()) {
      if (!ses.extensions.getExtension(extension.id)) continue
      ses.extensions.removeExtension(extension.id)
      void ses.extensions.loadExtension(extension.path, { allowFileAccess: true }).catch((error) => {
        console.error('[extensions] failed to reload', extension.id, error)
      })
    }
  }

  private spread(extension: Extension): void {
    if (this.settings?.get().disabledExtensions.some((d) => d.id === extension.id)) return
    for (const ses of this.contexts.keys()) {
      if (ses.extensions.getExtension(extension.id)) continue
      void ses.extensions.loadExtension(extension.path, { allowFileAccess: true }).catch((error) => {
        console.error('[extensions] failed to load', extension.id, error)
      })
    }
  }

  /** Installed extensions, loaded or turned off, for Settings. */
  list(): ExtensionInfo[] {
    const loaded = session.defaultSession.extensions.getAllExtensions().map((e) => describe(e, true))
    const off = (this.settings?.get().disabledExtensions ?? []).map(({ path: _path, ...rest }) => ({ ...rest, enabled: false }))
    return [...loaded, ...off.filter((o) => !loaded.some((l) => l.id === o.id))].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Turning an extension off unloads it now and on every launch; turning it on loads it again. */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const settings = this.settings
    if (!settings) return
    const disabled = settings.get().disabledExtensions
    if (enabled) {
      const entry = disabled.find((d) => d.id === id)
      if (!entry) return
      settings.update({ disabledExtensions: disabled.filter((d) => d.id !== id) })
      for (const ses of this.contexts.keys()) {
        await ses.extensions.loadExtension(entry.path, { allowFileAccess: true }).catch((error) => {
          console.error('[extensions] failed to load', id, error)
        })
      }
      return
    }
    const extension = session.defaultSession.extensions.getExtension(id)
    if (!extension) return
    const { enabled: _enabled, ...info } = describe(extension, true)
    settings.update({ disabledExtensions: [...disabled.filter((d) => d.id !== id), { ...info, path: extension.path }] })
    for (const ses of this.contexts.keys()) if (ses.extensions.getExtension(id)) ses.extensions.removeExtension(id)
  }

  /** Uninstalls an extension (its files too). */
  async remove(id: string): Promise<void> {
    const settings = this.settings
    if (settings) {
      const { disabledExtensions, pinnedExtensions } = settings.get()
      settings.update({
        disabledExtensions: disabledExtensions.filter((d) => d.id !== id),
        pinnedExtensions: pinnedExtensions.filter((p) => p !== id)
      })
    }
    await uninstallExtension(id, { session: session.defaultSession }).catch((error) => {
      console.error('[extensions] failed to uninstall', id, error)
    })
    for (const ses of this.contexts.keys()) if (ses.extensions.getExtension(id)) ses.extensions.removeExtension(id)
  }

  /** The extension's own settings page, if it has one. */
  optionsUrl(id: string): string | null {
    const extension = session.defaultSession.extensions.getExtension(id)
    const manifest = extension?.manifest as { options_ui?: { page?: string }; options_page?: string } | undefined
    const page = manifest?.options_ui?.page ?? manifest?.options_page
    return extension && page ? `chrome-extension://${id}/${page.replace(/^\//, '')}` : null
  }
}

/**
 * electron-chrome-extensions adds the extension APIs Electron lacks (windows, permissions, action…) to
 * `chrome` in every extension page and service worker, then freezes it. In Chrome, `browser` is the
 * same object as `chrome`, and new properties can be added to it: extensions that use `browser`
 * (1Password, uBlock Origin Lite) found those APIs missing and stopped, and ones that add to `chrome`
 * (SponsorBlock) couldn't start. Its preload is used with that fixed (the APIs themselves stay fixed
 * in place, as some extensions, Dark Reader, rely on); if a newer version reads differently, as it is.
 */
const PRELOAD_FREEZE = 'delete globalThis.electron;\n      Object.freeze(chrome);'
const PRELOAD_ALIAS = `delete globalThis.electron;
      if (chrome.scripting) {
        const scripting = chrome.scripting;
        const siteAccess = invokeExtension2("zepper.siteAccess");
        const denied = "Cannot access contents of the page. Extension manifest must request permission to access the respective host.";
        const gate = (name, queryOf) => {
          const original = scripting[name];
          if (typeof original !== "function") return original;
          return async function (details, callback) {
            if (!(await siteAccess(queryOf(details)))) {
              if (typeof callback === "function") return callback(undefined);
              throw new Error(denied);
            }
            return original.apply(scripting, arguments);
          };
        };
        const onTab = (details) => ({ tabId: details && details.target ? details.target.tabId : undefined });
        const onMatches = (details) => ({ matches: [].concat(details || []).flatMap((d) => (d && d.matches) || []) });
        Object.defineProperty(chrome, "scripting", {
          value: {
            ...scripting,
            executeScript: gate("executeScript", onTab),
            insertCSS: gate("insertCSS", onTab),
            removeCSS: gate("removeCSS", onTab),
            registerContentScripts: gate("registerContentScripts", onMatches),
            updateContentScripts: gate("updateContentScripts", onMatches)
          },
          enumerable: true,
          configurable: true,
          writable: true
        });
      }
      for (const key of Object.getOwnPropertyNames(chrome)) {
        try {
          Object.defineProperty(chrome, key, { writable: false, configurable: false });
        } catch {}
      }
      if (globalThis.browser && globalThis.browser !== chrome) {
        try {
          Object.defineProperty(globalThis, "browser", { value: chrome, writable: true, configurable: true, enumerable: true });
        } catch {}
        if (globalThis.browser !== chrome) {
          for (const key of Object.keys(chrome)) {
            try {
              Object.defineProperty(globalThis.browser, key, { value: chrome[key], writable: true, configurable: true, enumerable: true });
            } catch {}
          }
        }
      }`

/** chrome.tabs methods Zepper adds (see addApis): they go to main like the library's own. */
const PRELOAD_TABS = 'create: invokeExtension2("tabs.create"),'
const PRELOAD_TABS_ADDED = `create: invokeExtension2("tabs.create"),
              captureVisibleTab: invokeExtension2("tabs.captureVisibleTab"),
              detectLanguage: invokeExtension2("tabs.detectLanguage"),`

let patchedPreload: string | null | undefined

function extensionApiPreload(): string | null {
  if (patchedPreload !== undefined) return patchedPreload
  patchedPreload = null
  try {
    const original = createRequire(__filename).resolve('electron-chrome-extensions/preload')
    const source = readFileSync(original, 'utf8')
    if (!source.includes(PRELOAD_FREEZE) || !source.includes(PRELOAD_TABS)) {
      console.warn('[extensions] the extension API preload changed; using it as it is')
      return null
    }
    const path = join(app.getPath('userData'), 'extension-api.preload.js')
    writeFileSync(path, source.replace(PRELOAD_FREEZE, PRELOAD_ALIAS).replace(PRELOAD_TABS, PRELOAD_TABS_ADDED))
    patchedPreload = path
  } catch (error) {
    console.warn('[extensions] could not prepare the extension API preload', error)
  }
  return patchedPreload
}

/** Swaps electron-chrome-extensions' preload (same ids) for the fixed copy. */
function useExtensionApiPreload(ses: Session): void {
  const path = extensionApiPreload()
  if (!path) return
  for (const [id, type] of [
    ['crx-mv2-preload', 'frame'],
    ['crx-mv3-preload', 'service-worker']
  ] as const) {
    ses.unregisterPreloadScript(id)
    ses.registerPreloadScript({ id, type, filePath: path })
  }
}

/** The parts of electron-chrome-extensions' internals Zepper adds to. */
interface ExtensionsInternals {
  ctx: {
    router: { apiHandler(): (name: string, callback: (event: unknown, ...args: unknown[]) => unknown) => void }
    store: {
      lastFocusedWindowId?: number
      getWindowById(id: number): BrowserWindow | undefined
      getActiveTabFromWindow(win: BrowserWindow): WebContents | undefined
      getActiveTabOfCurrentWindow(): WebContents | undefined
      getTabById(id: number): WebContents | undefined
    }
  }
  api: {
    browserAction: { activateClick(details: { extensionId: string; tabId: number }): void }
    contextMenus: { onClicked(extensionId: string, menuItemId: string, tab: WebContents | undefined, params: unknown): void }
  }
}

interface RouterEvent {
  extension?: Extension
}

/** chrome.windows.WINDOW_ID_CURRENT */
const WINDOW_ID_CURRENT = -2

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/** Whether a URL is in a Chrome match pattern ("<all_urls>", "https://*.example.com/*"). */
export function matchesPattern(pattern: string, url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const scheme = parsed.protocol.slice(0, -1)
  if (pattern === '<all_urls>') return ['http', 'https', 'file', 'ws', 'wss', 'ftp'].includes(scheme)
  const match = /^(\*|[a-z][a-z0-9+.-]*):\/\/(\*|\*\.[^/*]+|[^/*]*)(\/.*)$/.exec(pattern)
  if (!match) return false
  const [, patternScheme, patternHost, patternPath] = match
  if (patternScheme === '*' ? !['http', 'https', 'ws', 'wss'].includes(scheme) : patternScheme !== scheme) return false
  const host = parsed.hostname
  if (patternHost !== '*') {
    if (patternHost.startsWith('*.')) {
      const base = patternHost.slice(2)
      if (host !== base && !host.endsWith(`.${base}`)) return false
    } else if (host !== patternHost) return false
  }
  const path = parsed.pathname + parsed.search
  const glob = new RegExp(`^${patternPath.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return glob.test(path)
}

/** The sites an extension reaches without being used on a page (see Extensions.noteSiteAccess). */
const SITE_ACCESS_FILE = 'zepper-site-access.json'

type Manifest = {
  manifest_version?: number
  permissions?: string[]
  host_permissions?: string[]
  content_scripts?: { matches?: string[]; js?: string[] }[]
}

const isHostPattern = (entry: string): boolean => entry === '<all_urls>' || entry.includes('://')

/**
 * An extension that asks for activeTab (to reach the page you use it on) and doesn't already reach
 * every site is given every site, keeping a note of the ones it asked for: Zepper then holds it to
 * those and the pages you use it on. Reports whether its files changed.
 */
function patchSiteAccess(extensionPath: string): boolean {
  try {
    if (existsSync(join(extensionPath, SITE_ACCESS_FILE))) return false
    const manifestPath = join(extensionPath, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
    const permissions = manifest.permissions ?? []
    if (!permissions.includes('activeTab')) return false
    const mv3 = manifest.manifest_version === 3
    const hosts = mv3 ? (manifest.host_permissions ?? []) : permissions.filter(isHostPattern)
    // Already on every website.
    if (['https://zepper.invalid/', 'http://zepper.invalid/'].every((url) => hosts.some((host) => matchesPattern(host, url)))) return false
    // (Its content scripts' sites don't count: in Chrome they don't let it run scripts there on demand.)
    writeFileSync(join(extensionPath, SITE_ACCESS_FILE), JSON.stringify({ hosts }, null, 2))
    if (mv3) manifest.host_permissions = [...hosts, '<all_urls>']
    else manifest.permissions = [...permissions, '<all_urls>']
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    return true
  } catch (error) {
    console.warn('[extensions] could not set up site access', extensionPath, error)
    return false
  }
}

/** The sites noted by patchSiteAccess, or null for an extension Zepper doesn't hold back. */
function readSiteAccess(extensionPath: string): string[] | null {
  try {
    const { hosts } = JSON.parse(readFileSync(join(extensionPath, SITE_ACCESS_FILE), 'utf8')) as { hosts?: unknown }
    return Array.isArray(hosts) ? hosts.map(String) : []
  } catch {
    return null
  }
}

/** Everything Zepper adjusts in an extension's files before loading it; whether anything changed. */
function prepareFiles(extensionPath: string): boolean {
  const scripts = patchContentScripts(extensionPath)
  const access = patchSiteAccess(extensionPath)
  return scripts || access
}

function describe(extension: Extension, enabled: boolean): ExtensionInfo {
  const manifest = extension.manifest as { description?: string; options_ui?: { page?: string }; options_page?: string; name?: string }
  return {
    id: extension.id,
    name: extension.name,
    version: extension.version,
    description: localized(manifest.description ?? '', extension),
    enabled,
    hasOptions: !!(manifest.options_ui?.page ?? manifest.options_page)
  }
}

/** Manifest strings like "__MSG_appDesc__" are localized; without the messages, leave them out. */
function localized(text: string, _extension: Extension): string {
  return /^__MSG_.+__$/.test(text) ? '' : text
}

const SYNC_SHIM = 'zepper-storage-sync.js'
const SYNC_SHIM_SOURCE = `// Added by Zepper. Electron has no chrome.storage.sync, so content scripts use local storage instead,
// as the extension's own pages (popup, options, background) already do: they then share settings.
(() => {
  for (const ns of [globalThis.chrome, globalThis.browser]) {
    const storage = ns && ns.storage
    if (!storage || !storage.local || storage.__zepperSync) continue
    try {
      Object.defineProperty(ns, 'storage', {
        value: { ...storage, sync: storage.local, managed: storage.local, __zepperSync: true },
        configurable: true,
        writable: true
      })
    } catch {}
  }
})()
`

/**
 * Electron provides chrome.storage.local but not chrome.storage.sync, which many extensions keep
 * their settings in. Their own pages get sync aliased to local (electron-chrome-extensions does
 * that), but their content scripts don't, so a setting changed in the popup never reaches the page.
 * This adds a tiny first content script that makes the same alias. Returns whether it changed the
 * extension (which then needs loading again).
 */
function patchContentScripts(extensionPath: string): boolean {
  try {
    const manifestPath = join(extensionPath, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { content_scripts?: { js?: string[] }[] }
    const scripts = (manifest.content_scripts ?? []).filter((entry) => Array.isArray(entry.js) && entry.js.length > 0)
    if (scripts.length === 0) return false
    const shimPath = join(extensionPath, SYNC_SHIM)
    const shimCurrent = existsSync(shimPath) && readFileSync(shimPath, 'utf8') === SYNC_SHIM_SOURCE
    const missing = scripts.filter((entry) => entry.js![0] !== SYNC_SHIM)
    if (missing.length === 0 && shimCurrent) return false
    writeFileSync(shimPath, SYNC_SHIM_SOURCE)
    for (const entry of missing) entry.js!.unshift(SYNC_SHIM)
    if (missing.length > 0) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    return true
  } catch (error) {
    // A manifest Zepper can't read (comments, say) is left as it is.
    console.warn('[extensions] could not add chrome.storage.sync for content scripts', extensionPath, error)
    return false
  }
}
