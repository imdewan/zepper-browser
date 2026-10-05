import {
  BrowserWindow,
  components,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  app,
  webContents,
  type Session,
  type WebContents
} from 'electron'
import { join } from 'node:path'
import { IPC, type Command, type WidevineStatus } from '@shared/types'
import type { AdBlock } from './adblock'
import { Browser, type BrowserKind, type WindowSeed } from './browser'
import { clientHintHeaders, servePageConfig, userAgentFor } from './compat'
import { bangs } from './bangs'
import { Downloads } from './downloads'
import { Extensions } from './extensions'
import { tidyMode, type TidyMode } from './tidy'
import { ZoomLevels } from './zoom'
import { SECURE_DNS_SERVERS } from '@shared/settings'
import type { History } from './history'
import type { SettingsStore } from './settings-store'
import { CertificateStore, SitePermissions } from './site'

export interface Services {
  history: History
  settings: SettingsStore
  adblock: AdBlock
  /** Remembered site permissions for normal windows. */
  permissions: SitePermissions
  certificates: CertificateStore
  extensions: Extensions | null
  rendererUrl: string | undefined
  rendererDir: string
}

/**
 * Owns the shared services and every open window. IPC from any renderer or
 * page is routed to the window that owns the sender, and each browsing
 * session (the shared one, and one per private window) is wired up once.
 */
export class Hub {
  readonly browsers = new Set<Browser>()
  readonly services: Services
  /** How Tidy works on this Mac (until checked: by site). */
  tidy: TidyMode = { kind: 'site', reason: 'Checking for Apple Intelligence…' }
  /** Page zoom per site, shared by all windows. */
  readonly zoom = new ZoomLevels()
  /** Whether Zepper opens links from other apps (macOS default browser). */
  defaultBrowser = false
  /** Set when quitting on purpose (restart), so Zepper doesn't ask first. */
  quitWithoutAsking = false
  private secureDns: string | null = null
  /** Every download, shared by all windows. */
  readonly downloads = new Downloads(() => {
    for (const browser of this.browsers) browser.refresh()
  })
  private main: Browser | null = null
  private privateCount = 0
  private readonly sessions = new Set<Session>()
  /** Our plain Chrome user agent, before any identity choice. */
  private readonly chromeUa = app.userAgentFallback
  private userAgent = app.userAgentFallback
  /** Google Widevine (castLabs' Electron builds only), see applyWidevine. */
  widevine: WidevineStatus = { state: 'unavailable', version: null }
  private widevineWanted: boolean | null = null
  /**
   * castLabs' updater can only install a component on a launch where updates were on from the
   * start (once its startup attempt has failed with updates off, it can't recover until restart).
   */
  private readonly widevineInstallableNow: boolean
  private widevineInstall: Promise<void> | null = null

  constructor(services: Omit<Services, 'extensions' | 'certificates' | 'permissions'>) {
    this.services = { ...services, permissions: new SitePermissions(), certificates: new CertificateStore(), extensions: null }
    this.widevineInstallableNow = services.settings.get().widevine

    // These answer only Zepper's own UI, never web pages.
    ipcMain.handle(IPC.getSnapshot, (event) => this.uiOwner(event.sender)?.publicSnapshot() ?? null)
    ipcMain.handle(IPC.suggest, (event, text: string) => this.uiOwner(event.sender)?.suggestions(String(text ?? '')) ?? [])
    ipcMain.handle(IPC.extensions, (event) => (this.uiOwner(event.sender) ? (this.services.extensions?.list() ?? []) : []))
    // Private windows keep no history, so their history page is empty.
    ipcMain.handle(IPC.history, (event, query: string) => {
      const browser = this.uiOwner(event.sender)
      return !browser || browser.kind === 'private' ? [] : services.history.list(String(query ?? ''), 2000)
    })
    ipcMain.on(IPC.command, (event, command: Command) => this.owner(event.sender)?.handleFromUi(event.sender, command))
    ipcMain.on(IPC.swipe, (event, phase: 'update' | 'end', dx: number, peak: number) =>
      this.owner(event.sender)?.onPageSwipe(event.sender.id, phase, Number(dx) || 0, Number(peak) || 0)
    )
    ipcMain.on(IPC.pipBack, (event) => this.owner(event.sender)?.onNativePipBack(event.sender.id))
    ipcMain.on('zepper:drm-needed', (event, host: string) => this.owner(event.sender)?.onWidevineNeeded(event.sender, String(host)))
    // Page dialogs (alert/confirm/prompt); the page is blocked until event.returnValue is set.
    ipcMain.on('zepper:dialog', (event, kind: string, message: string, value: string) => {
      const browser = this.owner(event.sender)
      if (browser) browser.onJsDialog(event, String(kind), String(message), String(value))
      else event.returnValue = kind === 'confirm' ? false : null
    })
    // HTTP authentication: ask in the window that owns the page (or the focused one for proxies).
    app.on('login', (event, wc, _details, authInfo, callback) => {
      const browser = (wc && this.owner(wc)) || this.focused()
      if (!browser) return
      event.preventDefault()
      browser.onLogin(wc ?? null, authInfo, callback)
    })
    servePageConfig(
      services.settings,
      () => this.userAgent,
      (url) => services.adblock.protects(url)
    )
    // Client certificates: you choose which (if any) a site gets.
    app.on('select-client-certificate', (event, wc, url, list, callback) => {
      event.preventDefault()
      const browser = this.owner(wc) ?? this.focused()
      if (browser) void browser.selectClientCertificate(url, list, callback)
      else callback()
    })
    app.on('browser-window-focus', () => this.refreshDefaultBrowser())
    this.refreshDefaultBrowser()

    nativeTheme.on('updated', () => this.applyAppIcon())
    services.settings.onChange(() => {
      this.applyAppIcon()
      this.applySettings()
    })
    this.applyAppIcon()
    this.applySettings()
    void tidyMode().then((mode) => {
      this.tidy = mode
      for (const browser of this.browsers) browser.refresh()
    })
  }

  /** Chrome extensions live in the shared session; they act on the focused normal window. */
  startExtensions(): void {
    const extensions = new Extensions(
      {
        window: () => this.focusedNormal().window(),
        createTab: (url, active) => this.focusedNormal().openTabForExtension(url, active),
        selectTab: (wc) => this.owner(wc)?.activateByWebContents(wc),
        removeTab: (wc) => this.owner(wc)?.removeByWebContents(wc)
      },
      session.fromPartition('zepper-ui')
    )
    this.services.extensions = extensions
    void extensions.start(this.services.settings)
  }

  /** Opens a window; with a URL it starts on that page instead of the command bar. */
  openWindow(kind: BrowserKind, url?: string): Browser {
    // With the main window closed, ⌘N brings it back (your spaces and tabs) rather than a blank one.
    if (kind === 'blank' && !this.main) kind = 'main'
    const ses = kind === 'private' ? session.fromPartition(`zepper-private-${++this.privateCount}`) : session.defaultSession
    this.attachSession(ses)
    // A new window opens on the space you're in, at your window's size.
    // Its size comes from the window you're in; its space only from a normal (not private) one.
    const from = kind === 'main' ? undefined : this.focused()
    const seed: WindowSeed | undefined = from?.seedForNewWindow(
      kind === 'blank' && from.kind !== 'private' && this.services.settings.get().newWindowSpace === 'current'
    )
    const browser = new Browser(this, kind, ses, seed)
    this.browsers.add(browser)
    if (kind === 'main') this.main = browser
    browser.start(url)
    return browser
  }

  windowClosed(browser: Browser): void {
    this.browsers.delete(browser)
    // Other windows stay open when the main one closes (it has saved its spaces and tabs);
    // Zepper quits with the last window.
    if (browser === this.main) this.main = null
  }

  /** The window that owns a WebContents: its chrome, overlay, player controls or one of its tabs. */
  /** The window whose own UI `wc` is (not a page in it). */
  private uiOwner(wc: WebContents): Browser | undefined {
    const browser = this.owner(wc)
    return browser?.isUi(wc) ? browser : undefined
  }

  owner(wc: WebContents | null | undefined): Browser | undefined {
    if (!wc) return undefined
    for (const browser of this.browsers) if (browser.owns(wc)) return browser
    return undefined
  }

  ownerOfWebContentsId(id: number): Browser | undefined {
    for (const browser of this.browsers) if (browser.ownsWebContentsId(id)) return browser
    return undefined
  }

  focused(): Browser | undefined {
    const win = BrowserWindow.getFocusedWindow()
    for (const browser of this.browsers) if (browser.window() === win) return browser
    return this.main ?? [...this.browsers][0]
  }

  /** The focused window that isn't private (extensions and "open in new tab" from other apps). */
  focusedNormal(): Browser {
    const focused = this.focused()
    if (focused && focused.kind !== 'private') return focused
    return this.main ?? [...this.browsers].find((b) => b.kind !== 'private') ?? this.openWindow('main')
  }

  persist(): void {
    this.main?.persistNow()
    this.zoom.flush()
    this.downloads.flush()
    this.services.permissions.flush()
    this.services.settings.flush()
  }

  /**
   * A space's profile (its own cookies, logins, storage and cache),
   * wired up like every browsing session. 'default' is Electron's default session.
   */
  profileSession(profile: string): Session {
    const ses = profile === 'default' ? session.defaultSession : session.fromPartition(`persist:space-${profile}`)
    this.attachSession(ses)
    return ses
  }

  /** Permission prompts, certificates, privacy headers, page preload, ad blocking and downloads for a session. */
  private attachSession(ses: Session): void {
    if (this.sessions.has(ses)) return
    this.sessions.add(ses)
    ses.setUserAgent(this.userAgent)
    const { certificates, adblock, settings } = this.services
    certificates.attach(ses)
    adblock.attachSession(ses)
    ses.registerPreloadScript({ type: 'frame', filePath: join(__dirname, '../preload/page.js') })
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers: Record<string, string> = clientHintHeaders(details.requestHeaders, this.userAgent)
      if (settings.get().globalPrivacyControl) Object.assign(headers, { 'Sec-GPC': '1', DNT: '1' })
      // Third parties don't get your cookies (their Set-Cookie is dropped in AdBlock).
      if (adblock.crossSiteCookiesBlocked(details)) {
        for (const key of Object.keys(headers)) if (key.toLowerCase() === 'cookie') delete headers[key]
      }
      callback({ requestHeaders: headers })
    })
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const browser = this.owner(wc)
      if (!browser) return callback(false)
      browser.requestPermission(wc, permission, callback, details)
    })
    ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
      const browser = this.owner(wc) ?? this.focused()
      return browser ? browser.checkPermission(permission, requestingOrigin, details) : false
    })
    ses.on('will-download', (_event, item, wc) => (this.owner(wc) ?? this.focused())?.handleDownload(item))
    // Screen sharing (getDisplayMedia): macOS's own picker, or a simple screen choice where it isn't available.
    ses.setDisplayMediaRequestHandler(
      (request, callback) => {
        void desktopCapturer
          .getSources({ types: ['screen'] })
          .then(async (screens) => {
            const host = (() => {
              try {
                return new URL(request.securityOrigin).host
              } catch {
                return 'This site'
              }
            })()
            const win = BrowserWindow.getFocusedWindow()
            const options = {
              type: 'question' as const,
              message: `${host} wants to share your screen`,
              buttons: [
                ...screens.map((s, i) => (screens.length === 1 ? 'Share Screen' : `Share ${s.name || `Screen ${i + 1}`}`)),
                'Cancel'
              ],
              defaultId: 0,
              cancelId: screens.length
            }
            const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
            const source = screens[response]
            callback(source ? { video: source } : {})
          })
          .catch(() => callback({}))
      },
      { useSystemPicker: true }
    )
  }

  /** Opens a link or file from another app in the window you're using. */
  openUrl(url: string): void {
    this.focusedNormal().openFromOutside(url)
  }

  /** Windows whose tabs won't come back after quitting (everything but the main window). */
  unrestoredWindows(): number {
    return [...this.browsers].filter((b) => b !== this.main && b.tabCount() > 0).length
  }

  /** The focused window when it isn't one of Zepper's (a sign-in popup, say). */
  focusedForeignWindow(): BrowserWindow | null {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    for (const browser of this.browsers) if (browser.window() === win) return null
    return win
  }

  makeDefaultBrowser(): void {
    app.setAsDefaultProtocolClient('http')
    app.setAsDefaultProtocolClient('https')
    // macOS asks you to confirm; check again once you have.
    setTimeout(() => this.refreshDefaultBrowser(), 1000)
  }

  private refreshDefaultBrowser(): void {
    const now = app.isDefaultProtocolClient('https')
    if (now === this.defaultBrowser) return
    this.defaultBrowser = now
    for (const browser of this.browsers) browser.refresh()
  }

  /** Clears browsing data in every profile (normal windows; private ones forget everything anyway). */
  async clearBrowsingData(what: { since: number; history: boolean; cookies: boolean; cache: boolean; downloads: boolean }): Promise<void> {
    if (what.history) this.services.history.clearSince(what.since)
    if (what.downloads) this.downloads.clear()
    const sessions = [...this.sessions].filter((ses) => !this.isPrivateSession(ses))
    for (const ses of sessions) {
      if (what.cookies) {
        await ses.clearStorageData().catch(() => {})
        await ses.clearAuthCache().catch(() => {})
      }
      if (what.cache) {
        await ses.clearCache().catch(() => {})
        await ses.clearCodeCaches({}).catch(() => {})
      }
    }
  }

  private isPrivateSession(ses: Session): boolean {
    return !ses.isPersistent()
  }

  /** Ad blocking switches and the browser identity, from settings. */
  private applySettings(): void {
    const settings = this.services.settings.get()
    this.applyWidevine(settings.widevine)
    bangs.enabled = settings.bangs
    this.services.adblock.setEnabled(settings.adblock)
    this.services.adblock.setAllowlist(settings.adblockAllowlist)
    this.services.adblock.setAnnoyances(settings.hideCookieBanners)
    this.services.adblock.setProtections({
      httpsUpgrade: settings.httpsUpgrade,
      cleanLinks: settings.cleanLinks,
      crossSiteCookies: settings.blockCrossSiteCookies
    })
    this.applySecureDns(settings.secureDns)

    const ua = userAgentFor(settings, this.chromeUa)
    if (ua === this.userAgent) return
    this.userAgent = ua
    app.userAgentFallback = ua
    for (const ses of this.sessions) ses.setUserAgent(ua)
    // Open pages pick it up on their next load.
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed() && this.sessions.has(wc.session)) wc.setUserAgent(ua)
    }
  }

  /**
   * Widevine is opt-in, like Brave: while it's off, castLabs' component updater
   * stays disabled so nothing is downloaded. Turning it on installs it straight
   * away (no restart needed on macOS) and keeps it updated.
   */
  private applyWidevine(wanted: boolean): void {
    if (this.widevineWanted === wanted) return
    this.widevineWanted = wanted
    if (!components) return this.setWidevine({ state: 'unavailable', version: null })
    const installed = (): string | null => components.status()[components.WIDEVINE_CDM_ID]?.version ?? null
    if (!wanted) {
      components.updatesEnabled = false
      return this.setWidevine({ state: 'off', version: installed() })
    }
    components.updatesEnabled = true
    const version = installed()
    if (!version && !this.widevineInstallableNow) return this.setWidevine({ state: 'restart', version: null })
    this.setWidevine({ state: version ? 'ready' : 'installing', version })
    this.widevineInstall = components.whenReady([components.WIDEVINE_CDM_ID]).then(
      () => {
        if (!this.widevineWanted) return
        this.setWidevine({ state: 'ready', version: installed() })
        for (const browser of this.browsers) browser.onWidevineReady()
      },
      (error: unknown) => {
        console.error('[widevine] install failed', error)
        if (this.widevineWanted) this.setWidevine({ state: 'error', version: null })
        for (const browser of this.browsers) browser.onWidevineFailed()
      }
    )
  }

  /**
   * On the launch that installs Widevine, wait for it (briefly) before opening windows, so
   * the page that needed it doesn't load first and fail.
   */
  async widevineSettled(timeoutMs: number): Promise<void> {
    if (!this.widevineInstall || this.widevine.state !== 'installing') return
    await Promise.race([this.widevineInstall, new Promise((resolve) => setTimeout(resolve, timeoutMs))])
  }

  /** Whether turning Widevine on now would need a restart to finish installing. */
  widevineNeedsRestart(): boolean {
    if (!components || this.widevineInstallableNow) return false
    return !components.status()[components.WIDEVINE_CDM_ID]?.version
  }

  /** DNS over HTTPS: off, upgrade when your DNS provider supports it, or always via a chosen provider. */
  private applySecureDns(choice: string): void {
    if (choice === this.secureDns) return
    this.secureDns = choice
    const servers = SECURE_DNS_SERVERS[choice as keyof typeof SECURE_DNS_SERVERS]
    try {
      if (choice === 'off') app.configureHostResolver({ secureDnsMode: 'off' })
      else if (servers) app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: [servers] })
      else app.configureHostResolver({ secureDnsMode: 'automatic' })
    } catch (error) {
      console.warn('[dns] could not configure secure DNS', error)
    }
  }

  /** Restarts Zepper (tabs and spaces are restored). */
  relaunch(): void {
    this.quitWithoutAsking = true
    // In development the renderer dev server goes away with this process; use the built UI.
    Reflect.deleteProperty(process.env, 'ELECTRON_RENDERER_URL')
    app.relaunch()
    app.quit()
  }

  private setWidevine(status: WidevineStatus): void {
    this.widevine = status
    for (const browser of this.browsers) browser.refresh()
  }

  private applyAppIcon(): void {
    const choice = this.services.settings.get().appIcon
    const dark = choice === 'dark' || (choice === 'auto' && nativeTheme.shouldUseDarkColors)
    app.dock?.setIcon(join(__dirname, `../../resources/${dark ? 'icon-dark' : 'icon'}.png`))
  }
}
