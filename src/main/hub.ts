import { BrowserWindow, components, ipcMain, nativeTheme, session, app, webContents, type Session, type WebContents } from 'electron'
import { join } from 'node:path'
import { IPC, type Command, type WidevineStatus } from '@shared/types'
import type { AdBlock } from './adblock'
import { Browser, type BrowserKind } from './browser'
import { clientHintHeaders, servePageConfig, userAgentFor } from './compat'
import { Downloads } from './downloads'
import { Extensions } from './extensions'
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

    ipcMain.handle(IPC.getSnapshot, (event) => this.owner(event.sender)?.publicSnapshot() ?? null)
    ipcMain.handle(IPC.suggest, (event, text: string) => this.owner(event.sender)?.suggestions(text) ?? [])
    // Private windows keep no history, so their history page is empty.
    ipcMain.handle(IPC.history, (event, query: string) =>
      this.owner(event.sender)?.kind === 'private' ? [] : services.history.list(String(query ?? ''), 2000)
    )
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
    servePageConfig(services.settings, () => this.userAgent)

    nativeTheme.on('updated', () => this.applyAppIcon())
    services.settings.onChange(() => {
      this.applyAppIcon()
      this.applySettings()
    })
    this.applyAppIcon()
    this.applySettings()
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
    void extensions.start()
  }

  /** Opens a window; with a URL it starts on that page instead of the command bar. */
  openWindow(kind: BrowserKind, url?: string): Browser {
    const ses = kind === 'private' ? session.fromPartition(`zepper-private-${++this.privateCount}`) : session.defaultSession
    this.attachSession(ses)
    const browser = new Browser(this, kind, ses)
    this.browsers.add(browser)
    if (kind === 'main') this.main = browser
    browser.start(url)
    return browser
  }

  windowClosed(browser: Browser): void {
    this.browsers.delete(browser)
    if (browser === this.main) {
      this.main = null
      app.quit()
    }
  }

  /** The window that owns a WebContents: its chrome, overlay, player controls or one of its tabs. */
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
    this.downloads.flush()
    this.services.permissions.flush()
    this.services.settings.flush()
  }

  /**
   * A space's profile (its own cookies, logins, storage and cache, like a Zen container),
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
      const headers = clientHintHeaders(details.requestHeaders, this.userAgent)
      callback({ requestHeaders: settings.get().globalPrivacyControl ? { ...headers, 'Sec-GPC': '1', DNT: '1' } : headers })
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
  }

  /** Ad blocking switches and the browser identity, from settings. */
  private applySettings(): void {
    const settings = this.services.settings.get()
    this.applyWidevine(settings.widevine)
    this.services.adblock.setEnabled(settings.adblock)
    this.services.adblock.setAllowlist(settings.adblockAllowlist)

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

  /** Restarts Zepper (tabs and spaces are restored). */
  relaunch(): void {
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
