import { BrowserWindow, ipcMain, nativeTheme, session, app, type Session, type WebContents } from 'electron'
import { join } from 'node:path'
import { IPC, type Command } from '@shared/types'
import type { AdBlock } from './adblock'
import { Browser, type BrowserKind } from './browser'
import { serveSignInCompat } from './compat'
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
  private main: Browser | null = null
  private privateCount = 0
  private readonly sessions = new WeakSet<Session>()

  constructor(services: Omit<Services, 'extensions' | 'certificates' | 'permissions'>) {
    this.services = { ...services, permissions: new SitePermissions(), certificates: new CertificateStore(), extensions: null }

    ipcMain.handle(IPC.getSnapshot, (event) => this.owner(event.sender)?.publicSnapshot() ?? null)
    ipcMain.handle(IPC.suggest, (event, text: string) => this.owner(event.sender)?.suggestions(text) ?? [])
    ipcMain.on(IPC.command, (event, command: Command) => this.owner(event.sender)?.handleFromUi(event.sender, command))
    ipcMain.on(IPC.swipe, (event, phase: 'update' | 'end', dx: number) =>
      this.owner(event.sender)?.onPageSwipe(event.sender.id, phase, dx)
    )
    ipcMain.on(IPC.pipBack, (event) => this.owner(event.sender)?.onNativePipBack(event.sender.id))
    serveSignInCompat(services.settings)

    nativeTheme.on('updated', () => this.applyAppIcon())
    services.settings.onChange(() => this.applyAppIcon())
    this.applyAppIcon()
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

  openWindow(kind: BrowserKind): Browser {
    const ses = kind === 'private' ? session.fromPartition(`zepper-private-${++this.privateCount}`) : session.defaultSession
    this.attachSession(ses)
    const browser = new Browser(this, kind, ses)
    this.browsers.add(browser)
    if (kind === 'main') this.main = browser
    browser.start()
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
    this.services.permissions.flush()
    this.services.settings.flush()
  }

  /** Permission prompts, certificates, privacy headers, page preload, ad blocking and downloads for a session. */
  private attachSession(ses: Session): void {
    if (this.sessions.has(ses)) return
    this.sessions.add(ses)
    const { certificates, adblock, settings } = this.services
    certificates.attach(ses)
    adblock.attachSession(ses)
    ses.registerPreloadScript({ type: 'frame', filePath: join(__dirname, '../preload/page.js') })
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders
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

  private applyAppIcon(): void {
    const choice = this.services.settings.get().appIcon
    const dark = choice === 'dark' || (choice === 'auto' && nativeTheme.shouldUseDarkColors)
    app.dock?.setIcon(join(__dirname, `../../resources/${dark ? 'icon-dark' : 'icon'}.png`))
  }
}
