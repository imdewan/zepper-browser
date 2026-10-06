import { BrowserWindow, nativeTheme, type WebContents, type WebFrameMain } from 'electron'
import { parse as parseDomain } from 'tldts-experimental'
import type { Settings } from '@shared/settings'
import { IPC, type AutofillState, type Command, type Rect, type SavedLogin } from '@shared/types'

/**
 * Passwords in sign-in forms: the dropdown under a username or password field, filling the
 * login you pick, and offering to save a new or changed password after you sign in. Logins
 * live in a PasswordStore (Apple Passwords); the page never sees the list, only the login you
 * choose, and only after you choose it.
 */

export type StoreStatus = { state: 'ready' } | { state: 'connect' } | { state: 'unavailable'; reason: string }

export interface PasswordStore {
  /** Whether save() asks you itself (Apple's "Save Password?" alert), so Zepper doesn't ask first. */
  readonly confirmsSaves: boolean
  status(): Promise<StoreStatus>
  /** Saved logins for a page (user names only). */
  logins(url: string): Promise<SavedLogin[]>
  /** The user name and password of one login, to fill. */
  password(url: string, id: string): Promise<{ username: string; password: string } | null>
  save(url: string, username: string, password: string): Promise<void>
  /** Connecting: macOS shows a code, which comes back through finishPairing. */
  startPairing(): Promise<void>
  finishPairing(pin: string): Promise<void>
  /** You closed the code prompt. */
  cancelPairing?(): void
  /** Says where the pairing code comes from, when it isn't macOS (the development store). */
  readonly pairingHint?: string
}

export const PASSWORDS_CHANNEL = 'zepper:passwords'
const FILL_CHANNEL = 'zepper:passwords-fill'
const OPEN_CHANNEL = 'zepper:passwords-open'

export type PageMessage =
  | { type: 'focus'; field: 'username' | 'password'; rect: [number, number, number, number] | null }
  | { type: 'blur' }
  | { type: 'key'; key: 'ArrowDown' | 'ArrowUp' | 'Enter' }
  | { type: 'submit'; username: string; password: string }

export interface AutofillHost {
  win: BrowserWindow
  /** The web preferences of Zepper's own UI views (preload, isolation). */
  uiPreferences: Electron.WebPreferences
  load(wc: WebContents, page: string): void
  settings(): Settings
  updateSettings(patch: Partial<Settings>): void
  /** Where a tab's page sits in the window, if it's on screen. */
  pageBounds(wc: WebContents): Rect | null
  /** Whether a page belongs to this window's visible tabs. */
  ownsVisiblePage(wc: WebContents): boolean
  /** macOS's own Passwords picker, for when the store can't be used (no browser entitlement). */
  canPickPasswords(): boolean
  /** Shows the picker under a field (window coordinates); the login you choose, or null. */
  pickPassword(anchor: Rect): Promise<{ username: string; password: string } | null>
  cancelPick(): void
}

const SAVE_WIDTH = 340
/** How long a typed password waits for the page to move on before the save offer is dropped. */
const SAVE_WAIT_MS = 15_000

interface Field {
  wc: WebContents
  frame: WebFrameMain
  origin: string
  url: string
  /** The field in window coordinates. */
  anchor: Rect
}

interface PendingSave {
  wc: WebContents
  url: string
  username: string
  password: string
  timer: NodeJS.Timeout
}

export class AutofillController {
  private popup: BrowserWindow | null = null
  /** Where the popup is, in window coordinates. */
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private pendingShow = false
  private focusPopup = false
  private ready: Promise<void> | null = null
  private field: Field | null = null
  private state: AutofillState | null = null
  private height = 0
  private offer: PendingSave | null = null
  private saving: Omit<PendingSave, 'timer'> | null = null
  private hideTimer: NodeJS.Timeout | null = null
  private readonly watched = new WeakSet<WebContents>()
  /** The login last filled from the list, so signing in with it doesn't offer to save it again. */
  private lastFilled: { origin: string; username: string } | null = null

  constructor(
    private readonly host: AutofillHost,
    private readonly store: PasswordStore
  ) {
    host.win.on('resize', () => this.hide())
  }

  /** The dropdown or save prompt while it's showing, and where it is in the window. */
  visible(): { webContents: WebContents; bounds: Rect } | null {
    const popup = this.livePopup()
    return this.state && popup?.isVisible() ? { webContents: popup.webContents, bounds: this.bounds } : null
  }

  webContents(): WebContents | null {
    return this.livePopup()?.webContents ?? null
  }

  /** A message from a page's sign-in field. */
  onPageMessage(wc: WebContents, frame: WebFrameMain | null, message: PageMessage): void {
    if (!this.host.settings().passwords || !frame || frame !== wc.mainFrame) return
    switch (message.type) {
      case 'focus':
        if (message.rect) void this.openFor(wc, frame, message.rect)
        return
      case 'blur':
        return this.scheduleHide()
      case 'key':
        if (this.field?.wc === wc && (this.state?.kind === 'logins' || this.state?.kind === 'picker')) {
          this.send({ type: 'autofill.key', key: message.key })
        }
        return
      case 'submit':
        return void this.noteSubmit(wc, frame.url, String(message.username ?? ''), String(message.password ?? ''))
    }
  }

  handle(command: Command): void {
    switch (command.type) {
      case 'autofill.fill':
        return void this.fill(command.loginId)
      case 'autofill.pick':
        return void this.pick()
      case 'autofill.connect':
        return void this.connect()
      case 'autofill.pin':
        return void this.enterPin(command.pin)
      case 'autofill.save':
        return void this.answerSave(command.choice)
      case 'autofill.dismiss':
        return this.close()
      case 'autofill.resize':
        this.height = Math.max(0, Math.min(600, Math.round(command.height)))
        return this.position()
      case 'autofill.openPasswords':
        this.close()
        return void import('electron').then(({ shell }) => shell.openPath('/System/Applications/Passwords.app'))
    }
  }

  /** Hides the dropdown (switching tabs, opening a panel). A waiting save prompt stays. */
  hide(): void {
    this.host.cancelPick()
    if (this.state?.kind === 'save') return
    this.close()
  }

  destroy(): void {
    this.clearOffer()
    this.saving = null
    this.livePopup()?.destroy()
    this.popup = null
  }

  // ---------------------------------------------------------------------------

  private async openFor(wc: WebContents, frame: WebFrameMain, rect: [number, number, number, number]): Promise<void> {
    if (!this.host.ownsVisiblePage(wc)) return
    const url = frame.url
    let origin: string
    try {
      const parsed = new URL(url)
      if (!secureForPasswords(parsed)) return
      origin = parsed.origin
    } catch {
      return
    }
    const bounds = this.host.pageBounds(wc)
    if (!bounds) return
    const zoom = wc.getZoomFactor()
    const [left, top, width, height] = rect.map((n) => Number(n) || 0)
    const anchor = { x: bounds.x + left * zoom, y: bounds.y + top * zoom, width: width * zoom, height: height * zoom }
    // Off the visible page (scrolled away or tiny): nothing to anchor to.
    if (anchor.y + anchor.height < bounds.y || anchor.y > bounds.y + bounds.height || anchor.width < 20) return
    this.cancelHide()
    this.field = { wc, frame, origin, url, anchor }
    this.watch(wc)

    const status = await this.store.status().catch((): StoreStatus => ({ state: 'unavailable', reason: 'Apple Passwords didn’t respond.' }))
    if (this.field?.wc !== wc) return
    const host = new URL(url).hostname.replace(/^www\./, '')
    if (status.state === 'unavailable') return this.host.canPickPasswords() ? this.show({ kind: 'picker', host }) : this.close()
    if (status.state === 'connect') {
      // Asked once per site and session; after "Not now" the fields stay quiet.
      if (this.declinedConnect.has(origin)) return this.close()
      return this.show({ kind: 'connect', host })
    }
    const logins = await this.store.logins(url).catch(() => [])
    if (this.field?.wc !== wc || this.field.url !== url) return
    if (logins.length === 0) return this.close()
    this.show({ kind: 'logins', host, logins })
  }

  private readonly declinedConnect = new Set<string>()

  private async fill(loginId: string): Promise<void> {
    const field = this.field
    if (!field || field.wc.isDestroyed()) return this.close()
    // The page may have moved on since the list opened: only fill the page it was opened for.
    if (frameOrigin(field.frame) !== field.origin) return this.close()
    const login = await this.store.password(field.url, loginId).catch(() => null)
    this.close()
    if (!login) return
    this.lastFilled = { origin: field.origin, username: login.username }
    field.wc.focus()
    field.frame.send(FILL_CHANNEL, login)
  }

  /** macOS's picker: a small native panel under the field, where AutoFill offers your saved logins. */
  private async pick(): Promise<void> {
    const field = this.field
    this.close()
    if (!field || field.wc.isDestroyed()) return
    const login = await this.host.pickPassword(field.anchor).catch(() => null)
    if (!login || field.wc.isDestroyed()) return
    if (frameOrigin(field.frame) !== field.origin) return
    this.lastFilled = { origin: field.origin, username: login.username }
    field.wc.focus()
    field.frame.send(FILL_CHANNEL, login)
  }

  private async connect(): Promise<void> {
    const host = this.state && 'host' in this.state ? this.state.host : ''
    try {
      await this.store.startPairing()
      this.show({ kind: 'pin', host, hint: this.store.pairingHint }, true)
    } catch (error) {
      this.show({ kind: 'connect', host, error: message(error, 'Couldn’t reach Apple Passwords.') })
    }
  }

  private async enterPin(pin: string): Promise<void> {
    const host = this.state && 'host' in this.state ? this.state.host : ''
    try {
      await this.store.finishPairing(pin)
    } catch (error) {
      return this.show(
        { kind: 'pin', host, hint: this.store.pairingHint, error: message(error, 'That code didn’t work. Try again.') },
        true
      )
    }
    // Connected: carry on with what you were doing.
    if (this.saving) return this.show({ kind: 'save', host, username: this.saving.username, update: false })
    const field = this.field
    if (field && !field.wc.isDestroyed()) {
      const logins = await this.store.logins(field.url).catch(() => [])
      if (logins.length > 0) {
        this.close()
        field.wc.focus()
        return this.show({ kind: 'logins', host, logins })
      }
    }
    this.close()
    field?.wc.focus()
  }

  /** A sign-in form was sent: offer to save once the page moves on (a failed sign-in usually doesn't). */
  private async noteSubmit(wc: WebContents, url: string, username: string, password: string): Promise<void> {
    if (!password || password.length > 512 || username.length > 512) return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (!secureForPasswords(parsed)) return
    const domain = parseDomain(parsed.hostname).domain ?? parsed.hostname
    if (this.host.settings().neverSavePasswords.includes(domain)) return
    this.clearOffer()
    const timer = setTimeout(() => this.clearOffer(), SAVE_WAIT_MS)
    this.offer = { wc, url, username, password, timer }
    this.watch(wc)
  }

  /** The page with a pending save offer navigated: the sign-in went through. */
  private async pageMovedOn(wc: WebContents): Promise<void> {
    const offer = this.offer
    if (!offer || offer.wc !== wc) return
    this.clearOffer()
    if (this.lastFilled?.origin === new URL(offer.url).origin && this.lastFilled.username === offer.username) return
    const status = await this.store.status().catch(() => null)
    if (status?.state !== 'ready') return
    const logins = await this.store.logins(offer.url).catch(() => [])
    const match = logins.find((l) => l.username === offer.username)
    if (this.store.confirmsSaves) {
      // Reading the saved password back would ask for Touch ID, so a known account isn't offered again;
      // a new one goes straight to Apple's own "Save Password?" alert.
      if (match) return
      return void this.store
        .save(offer.url, offer.username, offer.password)
        .catch((error) => console.warn('[passwords] save failed', error))
    }
    if (match) {
      const saved = await this.store.password(offer.url, match.id).catch(() => null)
      if (saved?.password === offer.password) return
    }
    if (!this.host.ownsVisiblePage(wc)) return
    this.saving = { wc, url: offer.url, username: offer.username, password: offer.password }
    this.field = null
    this.show({ kind: 'save', host: new URL(offer.url).hostname.replace(/^www\./, ''), username: offer.username, update: Boolean(match) })
    // Unanswered prompts don't keep the password around.
    setTimeout(() => {
      if (this.state?.kind === 'save' && this.saving?.password === offer.password) this.answerSave('later')
    }, 60_000)
  }

  private async answerSave(choice: 'save' | 'later' | 'never'): Promise<void> {
    const saving = this.saving
    this.saving = null
    this.close()
    if (!saving) return
    if (choice === 'never') {
      const hostname = new URL(saving.url).hostname
      const domain = parseDomain(hostname).domain ?? hostname
      const list = this.host.settings().neverSavePasswords
      if (!list.includes(domain)) this.host.updateSettings({ neverSavePasswords: [...list, domain] })
      return
    }
    if (choice !== 'save') return
    try {
      await this.store.save(saving.url, saving.username, saving.password)
    } catch (error) {
      console.warn('[passwords] save failed', error)
    }
  }

  private clearOffer(): void {
    if (this.offer) clearTimeout(this.offer.timer)
    this.offer = null
  }

  private watch(wc: WebContents): void {
    if (this.watched.has(wc)) return
    this.watched.add(wc)
    wc.on('did-start-navigation', (_e, _url, inPage, isMainFrame) => {
      if (!isMainFrame) return
      if (this.field?.wc === wc && !inPage) this.hide()
    })
    wc.on('did-navigate', () => void this.pageMovedOn(wc))
    wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => isMainFrame && void this.pageMovedOn(wc))
    wc.once('destroyed', () => {
      if (this.field?.wc === wc) this.close()
      if (this.offer?.wc === wc) this.clearOffer()
    })
  }

  // ---------------------------------------------------------------------------
  // The popup: a small borderless child window, so it gets a real macOS shadow, can hang over the
  // window's edge, and never takes focus from the page (except to type the pairing code).

  private show(state: AutofillState, focus = false): void {
    this.cancelHide()
    this.state = state
    const popup = this.ensurePopup()
    this.focusPopup = focus
    void this.ready?.then(() => {
      if (this.state !== state || popup.isDestroyed()) return
      // Shown once the page reports its height for this state (see 'autofill.resize').
      this.pendingShow = true
      this.send({ type: 'autofill.show', state, dark: nativeTheme.shouldUseDarkColors })
      this.setPageDropdown(state.kind === 'logins' || state.kind === 'picker')
    })
  }

  private close(): void {
    this.cancelHide()
    if (this.state?.kind === 'connect' && this.field) this.declinedConnect.add(this.field.origin)
    if (this.state?.kind === 'save') this.saving = null
    if (this.state?.kind === 'pin') this.store.cancelPairing?.()
    this.setPageDropdown(false)
    this.state = null
    this.pendingShow = false
    const popup = this.livePopup()
    if (popup) {
      const hadFocus = popup.isFocused()
      popup.setFocusable(false)
      popup.hide()
      if (hadFocus) this.host.win.focus()
    }
  }

  /** The field lost focus: close soon (the popup itself never takes it, apart from the code prompt). */
  private scheduleHide(): void {
    this.cancelHide()
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null
      if (this.state?.kind === 'save' || this.state?.kind === 'pin') return
      this.close()
    }, 150)
  }

  private cancelHide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = null
  }

  private setPageDropdown(open: boolean): void {
    const field = this.field
    if (field && !field.wc.isDestroyed()) {
      try {
        field.frame.send(OPEN_CHANNEL, open)
      } catch {
        // The frame went away.
      }
    }
  }

  private send(event: Parameters<WebContents['send']>[1]): void {
    const wc = this.webContents()
    if (wc) wc.send(IPC.event, event)
  }

  private livePopup(): BrowserWindow | null {
    return this.popup && !this.popup.isDestroyed() ? this.popup : null
  }

  private ensurePopup(): BrowserWindow {
    const existing = this.livePopup()
    if (existing) return existing
    const popup = new BrowserWindow({
      parent: this.host.win,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      acceptFirstMouse: true,
      backgroundColor: '#00000000',
      webPreferences: this.host.uiPreferences
    })
    popup.webContents.on('will-navigate', (event) => event.preventDefault())
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.popup = popup
    this.ready = new Promise((resolve) => popup.webContents.once('did-finish-load', () => resolve()))
    this.host.load(popup.webContents, 'autofill.html')
    return popup
  }

  /** Places the popup (in window coordinates), showing it if it's waiting for its size. */
  private position(): void {
    const popup = this.livePopup()
    const state = this.state
    if (!popup || !state || this.height === 0) return
    const [winWidth, winHeight] = this.host.win.getContentSize()
    const height = this.height
    let x: number
    let y: number
    let width: number
    if (state.kind === 'save' || !this.field) {
      // The save prompt sits at the top right of the page.
      const page = (this.saving && !this.saving.wc.isDestroyed() && this.host.pageBounds(this.saving.wc)) || this.activeBounds()
      width = SAVE_WIDTH
      x = page.x + page.width - width - 10
      y = page.y + 10
    } else {
      const { anchor } = this.field
      width = Math.min(380, Math.max(state.kind === 'logins' || state.kind === 'picker' ? 260 : 320, anchor.width))
      x = anchor.x
      y = anchor.y + anchor.height + 4
      // No room below: open above the field.
      if (y + height > winHeight) y = Math.max(0, anchor.y - 4 - height)
    }
    x = Math.round(Math.max(0, Math.min(x, winWidth - width)))
    this.bounds = { x, y: Math.round(y), width: Math.round(width), height: Math.round(height) }
    const content = this.host.win.getContentBounds()
    popup.setBounds({ ...this.bounds, x: content.x + this.bounds.x, y: content.y + this.bounds.y })
    if (this.pendingShow) {
      this.pendingShow = false
      if (this.focusPopup) {
        popup.setFocusable(true)
        popup.show()
        popup.focus()
      } else {
        popup.setFocusable(false)
        popup.showInactive()
      }
    }
    // The shadow follows the card's shape; recompute it once the new size has painted.
    setTimeout(() => this.livePopup()?.invalidateShadow(), 40)
  }

  private activeBounds(): Rect {
    const [width, height] = this.host.win.getContentSize()
    return { x: 0, y: 0, width, height }
  }
}

/** The origin a frame is showing now ('' if it's gone). */
function frameOrigin(frame: WebFrameMain): string {
  try {
    return new URL(frame.url).origin
  } catch {
    return ''
  }
}

/** Passwords are only offered and saved on secure pages (HTTPS, or a local development server). */
function secureForPasswords(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname))
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message && !/^\[/.test(error.message) ? error.message : fallback
}
