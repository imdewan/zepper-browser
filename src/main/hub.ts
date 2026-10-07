import {
  BrowserWindow,
  components,
  ipcMain,
  nativeTheme,
  screen,
  session,
  shell,
  systemPreferences,
  app,
  webContents,
  type Session,
  type WebContents
} from 'electron'
import { join } from 'node:path'
import {
  type DropTarget,
  IPC,
  type AccessState,
  type Command,
  type IntelligenceStatus,
  type SystemAccess,
  type VaultRequest,
  type WidevineStatus
} from '@shared/types'
import type { AdBlock } from './adblock'
import { Browser, declineShare, type BrowserKind, type WindowSeed } from './browser'
import { clientHintHeaders, servePageConfig, userAgentFor } from './compat'
import { bangs } from './bangs'
import { Downloads } from './downloads'
import { Extensions } from './extensions'
import { tidyMode, type TidyMode } from './tidy'
import { intelligence } from './ai'
import { ZoomLevels } from './zoom'
import { SECURE_DNS_SERVERS } from '@shared/settings'
import type { History } from './history'
import type { SemanticHistory } from './semantic'
import type { SettingsStore } from './settings-store'
import { CertificateStore, SitePermissions } from './site'
import { PASSWORDS_CHANNEL, type PageMessage } from './autofill'
import { handleVaultRequest } from './password-settings'
import { Vault } from './vault'
import { locationAccess } from './native'
import { RELEASES_PAGE, Updater } from './updater'

const WEBAUTHN_CHANNEL = 'zepper:webauthn'
const WEBAUTHN_CANCEL_CHANNEL = 'zepper:webauthn-cancel'

export interface Services {
  history: History
  /** History searchable by meaning (on-device embeddings). */
  semantic: SemanticHistory
  settings: SettingsStore
  adblock: AdBlock
  /** Remembered site permissions for normal windows. */
  permissions: SitePermissions
  certificates: CertificateStore
  extensions: Extensions | null
  /** Zepper's password manager: saved passwords and passkeys. */
  vault: Vault
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
  /** What the on-device intelligence helper can do (until checked: nothing). */
  aiStatus: IntelligenceStatus = { ai: false, reason: 'Checking for Apple Intelligence…', translation: false, embeddings: false }
  /** Page zoom per site, shared by all windows. */
  readonly zoom = new ZoomLevels()
  /** Whether Zepper opens links from other apps (macOS default browser). */
  defaultBrowser = false
  /** Set when quitting on purpose (restart), so Zepper doesn't ask first. */
  quitWithoutAsking = false
  private secureDns: string | null = null
  /** Zepper's own updates. */
  readonly updater = new Updater(
    () => {
      for (const browser of this.browsers) browser.refresh()
    },
    () => this.services.settings.get().autoUpdate
  )
  /** What macOS lets Zepper use (camera, microphone, screen); checked when a window comes forward. */
  systemAccess: SystemAccess = { camera: 'ask', microphone: 'ask', screen: 'ask', location: 'ask' }
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

  constructor(services: Omit<Services, 'extensions' | 'certificates' | 'permissions' | 'vault'>) {
    this.services = {
      ...services,
      permissions: new SitePermissions(),
      certificates: new CertificateStore(),
      extensions: null,
      vault: new Vault()
    }
    this.widevineInstallableNow = services.settings.get().widevine

    // These answer only Zepper's own UI, never web pages.
    ipcMain.handle(IPC.getSnapshot, (event) => this.uiOwner(event.sender)?.publicSnapshot() ?? null)
    ipcMain.handle(IPC.suggest, (event, text: string) => this.uiOwner(event.sender)?.suggestions(String(text ?? '')) ?? [])
    ipcMain.handle(IPC.extensions, (event) => (this.uiOwner(event.sender) ? (this.services.extensions?.list() ?? []) : []))
    ipcMain.handle(IPC.downloadIcon, (event, id: unknown) => (this.uiOwner(event.sender) ? this.downloads.iconOf(String(id)) : null))
    // Private windows keep no history, so their history page is empty.
    ipcMain.handle(IPC.history, (event, query: string) => {
      const browser = this.uiOwner(event.sender)
      return !browser || browser.kind === 'private' ? [] : services.history.list(String(query ?? ''), 2000)
    })
    ipcMain.handle(IPC.historyMeaning, async (event, query: string) => {
      const browser = this.uiOwner(event.sender)
      if (!browser || browser.kind === 'private' || !services.settings.get().aiFeatures) return []
      return services.semantic.search(String(query ?? '').slice(0, 300)).catch(() => [])
    })
    ipcMain.on(IPC.command, (event, command: Command) => this.owner(event.sender)?.handleFromUi(event.sender, command))
    ipcMain.on(IPC.swipe, (event, phase: 'update' | 'end', dx: number, peak: number) =>
      this.owner(event.sender)?.onPageSwipe(event.sender, phase, Number(dx) || 0, Number(peak) || 0)
    )
    ipcMain.on(IPC.pipBack, (event) => this.owner(event.sender)?.onNativePipBack(event.sender.id))
    // Sign-in fields: the passwords dropdown, filling, and offering to save.
    ipcMain.on(PASSWORDS_CHANNEL, (event, message: PageMessage) => {
      if (message && typeof message === 'object') this.owner(event.sender)?.onPasswordsMessage(event.sender, event.senderFrame, message)
    })
    ipcMain.on('zepper:drm-needed', (event, host: string) => this.owner(event.sender)?.onWidevineNeeded(event.sender, String(host)))
    // Page dialogs (alert/confirm/prompt); the page is blocked until event.returnValue is set.
    ipcMain.on('zepper:dialog', (event, kind: string, message: string, value: string) => {
      const browser = this.owner(event.sender)
      if (kind === 'print') {
        event.returnValue = null
        return browser?.printPage(event.sender)
      }
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
      (url) => services.adblock.protects(url, 'fingerprinting'),
      (sender, origin) => this.owner(sender)?.blockedPermissions(origin) ?? []
    )
    // Passkeys: pages' WebAuthn requests, answered by the window showing the page.
    ipcMain.handle(WEBAUTHN_CHANNEL, async (event, kind: string, options: string) => {
      const browser = this.owner(event.sender)
      if (!browser || (kind !== 'create' && kind !== 'get'))
        return JSON.stringify({ ok: false, name: 'NotAllowedError', message: 'Not allowed.' })
      return browser.onWebAuthn(event.sender, event.senderFrame, kind, String(options ?? '{}'))
    })
    ipcMain.on(WEBAUTHN_CANCEL_CHANNEL, (event) => this.owner(event.sender)?.cancelWebAuthn(event.sender))
    // Pages say when they start or stop using the camera, microphone or screen (for the tab's indicators).
    ipcMain.on('zepper:capture', (event, detail: unknown) =>
      this.owner(event.sender)?.onCapture(event.sender, event.senderFrame, String(detail))
    )
    ipcMain.on('zepper:typing', (event, typing: unknown) =>
      this.owner(event.sender)?.onTyping(event.sender, event.senderFrame, typing === true)
    )
    // Settings › Passwords (Zepper's own UI only).
    ipcMain.handle(IPC.vault, async (event, request: VaultRequest) => {
      const browser = this.uiOwner(event.sender)
      if (!browser || !request || typeof request !== 'object') return null
      return handleVaultRequest(this.services.vault, services.history, services.settings, browser.window(), request, (session, name) =>
        browser.importSession(session, name)
      )
    })
    // Client certificates: you choose which (if any) a site gets.
    app.on('select-client-certificate', (event, wc, url, list, callback) => {
      event.preventDefault()
      const browser = this.owner(wc) ?? this.focused()
      if (browser) void browser.selectClientCertificate(url, list, callback)
      else callback()
    })
    app.on('browser-window-focus', () => {
      this.refreshDefaultBrowser()
      this.refreshSystemAccess()
    })
    this.refreshDefaultBrowser()
    this.refreshSystemAccess()
    // Site decisions show in Settings, in every window.
    this.services.permissions.onChange(() => {
      for (const browser of this.browsers) browser.refresh()
    })

    nativeTheme.on('updated', () => this.applyAppIcon())
    services.settings.onChange((next, prev) => {
      // Sliders change settings many times a second: only redo what the change touched.
      if (next.appIcon !== prev.appIcon) this.applyAppIcon()
      const touched = (keys: (keyof typeof next)[]): boolean => keys.some((key) => next[key] !== prev[key])
      if (
        touched([
          'widevine',
          'bangs',
          'adblock',
          'adblockAllowlist',
          'siteExceptions',
          'hideCookieBanners',
          'httpsUpgrade',
          'cleanLinks',
          'blockCrossSiteCookies',
          'secureDns',
          'userAgent',
          'customUserAgent'
        ])
      )
        this.applySettings()
    })
    this.applyAppIcon()
    this.applySettings()
    void intelligence.status().then((status) => {
      this.aiStatus = status
      for (const browser of this.browsers) browser.refresh()
    })
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
    // Every space's browsing session (not private windows') runs the extensions too.
    for (const ses of this.sessions) if (ses.isPersistent()) extensions.attach(ses)
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

  /** A tab dragged to another window's sidebar moves there, still running (see Browser.releaseTab). */
  moveTab(tabId: string, to: Browser, target: DropTarget): void {
    const from = [...this.browsers].find((browser) => browser !== to && browser.hasTab(tabId))
    if (!from || from.kind === 'private' || to.kind === 'private') return
    const moving = from.releaseTab(tabId)
    if (moving) to.adoptTab(moving, target.spaceId, target)
  }

  /**
   * A tab dragged out of a window's sidebar and let go somewhere nothing took it: over another
   * window, it joins that one; anywhere else, its own window's page included, it gets a window of
   * its own there (with your spaces), as Chrome detaches a tab dragged off its tab strip. Either way
   * its page keeps running. Let go back in its own sidebar, nothing happens.
   */
  tearOffTab(from: Browser, tabId: string): void {
    if (from.kind === 'private' || !from.hasTab(tabId)) return
    const point = screen.getCursorScreenPoint()
    const inside = (r: Electron.Rectangle | null): boolean =>
      !!r && point.x >= r.x && point.x < r.x + r.width && point.y >= r.y && point.y < r.y + r.height
    const over = (browser: Browser): boolean => {
      const win = browser.window()
      return !win.isDestroyed() && win.isVisible() && !win.isMinimized() && inside(win.getBounds())
    }
    if (inside(from.sidebarScreenRect())) return
    // The window in front under the pointer (the source's own page counts as "elsewhere").
    const front = BrowserWindow.getFocusedWindow()
    const others = [...this.browsers].filter((browser) => browser !== from && browser.kind !== 'private' && over(browser))
    const other = over(from) ? undefined : (others.find((browser) => browser.window() === front) ?? others[0])
    if (other) {
      const moving = from.releaseTab(tabId)
      if (moving) other.adoptTab(moving, other.currentSpaceId(), null)
      return
    }
    const seed = from.seedForNewWindow(true)
    const space = from.spaceOfTab(tabId)
    const moving = from.releaseTab(tabId)
    if (!moving) return
    // Where you let go (a new window is placed a little down and right of its seed).
    seed.bounds = { ...seed.bounds, x: Math.round(point.x - 164), y: Math.round(point.y - 44) }
    const browser = new Browser(this, 'blank', session.defaultSession, seed)
    this.browsers.add(browser)
    browser.start()
    browser.adoptTab(moving, (space && seed.spaceIds?.[space]) || browser.currentSpaceId(), null)
  }

  windowClosed(browser: Browser): void {
    this.browsers.delete(browser)
    // A private window's session ends with it: its cache too (not only cookies and storage), and Zepper stops holding it.
    if (browser.kind === 'private') {
      const ses = browser.session()
      void Promise.all([ses.clearStorageData(), ses.clearCache(), ses.clearCodeCaches({}), ses.clearHostResolverCache()]).catch(() => {})
      this.sessions.delete(ses)
      this.services.adblock.detachSession(ses)
    }
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

  /** Before quitting: every window's pages close themselves (see Browser.closePagesGently). */
  async closePagesGently(): Promise<void> {
    await Promise.all([...this.browsers].map((browser) => browser.closePagesGently()))
  }

  persist(): void {
    this.main?.persistNow()
    this.zoom.flush()
    this.services.semantic.flush()
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
    if (ses.isPersistent()) this.services.extensions?.attach(ses)
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
    ses.on('will-download', (_event, item, wc) => (this.owner(wc) ?? this.focused())?.handleDownload(item, wc))
    // Screen sharing (getDisplayMedia): Zepper's picker, in the window showing the page.
    ses.setDisplayMediaRequestHandler((request, callback) => {
      const wc = request.frame ? webContents.fromFrame(request.frame) : undefined
      const browser = wc ? this.owner(wc) : null
      if (!wc || !browser) return declineShare(callback)
      void browser.chooseShareSource(wc, request, callback)
    })
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

  /** Asks macOS again what Zepper may use (after a prompt, or coming back from System Settings). */
  refreshSystemAccess(): void {
    const read = (kind: 'camera' | 'microphone' | 'screen'): AccessState => {
      if (process.platform !== 'darwin') return 'allowed'
      const status = systemPreferences.getMediaAccessStatus(kind)
      return status === 'granted' ? 'allowed' : status === 'denied' || status === 'restricted' ? 'denied' : 'ask'
    }
    const next: SystemAccess = {
      camera: read('camera'),
      microphone: read('microphone'),
      screen: read('screen'),
      location: process.platform === 'darwin' ? locationAccess() : 'allowed'
    }
    if (JSON.stringify(next) === JSON.stringify(this.systemAccess)) return
    this.systemAccess = next
    for (const browser of this.browsers) browser.refresh()
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
    this.services.adblock.setAllowlist(settings.adblockAllowlist, settings.siteExceptions)
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

  /** Restarts into the downloaded update, or opens the download page where Zepper can't update itself. */
  restartToUpdate(): void {
    if (this.updater.restartToUpdate()) {
      this.quitWithoutAsking = true
      app.quit()
    } else if (this.updater.status.state === 'manual') {
      void shell.openExternal(RELEASES_PAGE)
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

  private appIconSet = false

  private applyAppIcon(): void {
    const choice = this.services.settings.get().appIcon
    // Installed, "Auto" is the app's own icon (its asset catalog): macOS shows light, dark, clear or
    // tinted to match your icon style, the same whether Zepper is open or not, as for every other app.
    if (choice === 'auto' && app.isPackaged) {
      // Only undo an icon set earlier (Light or Dark chosen this session); otherwise leave macOS's.
      if (this.appIconSet) app.dock?.setIcon(null as unknown as string)
      this.appIconSet = false
      return
    }
    const dark = choice === 'dark' || (choice === 'auto' && nativeTheme.shouldUseDarkColors)
    app.dock?.setIcon(join(__dirname, `../../resources/${dark ? 'icon-dark' : 'icon'}.png`))
    this.appIconSet = true
  }
}
