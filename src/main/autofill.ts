import { BrowserWindow, nativeTheme, type WebContents, type WebFrameMain } from 'electron'
import { randomInt } from 'node:crypto'
import { parse as parseDomain } from 'tldts-experimental'
import type { Settings } from '@shared/settings'
import { IPC, type AutofillItem, type AutofillState, type Command, type PhoneStatus, type Rect } from '@shared/types'
import { getAssertion, makeCredential } from './authenticator'
import { HybridSession } from './hybrid'
import { verifyOwner } from './native'
import {
  WebAuthnError,
  cancelSystemPasskey,
  checkRequest,
  systemPasskey,
  systemPasskeysAvailable,
  type PasskeyRequest,
  type Verification
} from './passkeys'
import type { Vault } from './vault'

/**
 * Zepper's password manager in pages: the dropdown under sign-in fields (saved logins, passkeys
 * a page is ready to accept, a strong password for new accounts), the offer to save a password
 * after you sign in, and the sheets for creating and using passkeys. Pages never see the list,
 * only the login you choose, after you choose it. Everything is drawn in one small borderless
 * child window, so it has a real shadow and never takes focus from the page.
 */

export const PASSWORDS_CHANNEL = 'zepper:passwords'
const FILL_CHANNEL = 'zepper:passwords-fill'
const OPEN_CHANNEL = 'zepper:passwords-open'

export type FieldKind = 'username' | 'password' | 'new-password'

export type PageMessage =
  /** pointer: in an iframe, the last pointer event's screen and client position (to place the list). */
  | { type: 'focus'; field: FieldKind; rect: [number, number, number, number] | null; pointer?: [number, number, number, number] | null }
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
  /** Settings › Passwords. */
  openPasswordSettings(): void
}

const SHEET_WIDTH = 340
/** How long a typed password waits for the page to move on before the save offer is dropped. */
const SAVE_WAIT_MS = 15_000
/** A passkey request nobody answers fails after this long, as browsers' do. */
const PASSKEY_TIMEOUT_MS = 5 * 60_000

interface Field {
  wc: WebContents
  frame: WebFrameMain
  kind: FieldKind
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

/** A page's passkey request waiting for you. */
interface Ticket {
  wc: WebContents
  request: PasskeyRequest
  resolve: (reply: string) => void
  timer: NodeJS.Timeout | null
}

const ok = (result: Record<string, unknown>): string => JSON.stringify({ ok: true, result })
const failure = (name: string, message: string): string => JSON.stringify({ ok: false, name, message })
const NOT_ALLOWED = failure(
  'NotAllowedError',
  'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.'
)

/** A strong password in Apple's style: three groups of six, with one capital and one digit (about 90 bits). */
export function strongPassword(): string {
  const letters = 'abcdefghijkmnopqrstuvwxyz'
  const chars = Array.from({ length: 18 }, () => letters[randomInt(letters.length)])
  const capital = randomInt(18)
  let digit = randomInt(18)
  while (digit === capital) digit = randomInt(18)
  chars[capital] = chars[capital].toUpperCase()
  chars[digit] = String(randomInt(2, 10))
  return [chars.slice(0, 6), chars.slice(6, 12), chars.slice(12)].map((group) => group.join('')).join('-')
}

export class AutofillController {
  private popup: BrowserWindow | null = null
  /** Where the popup is, in window coordinates. */
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private pendingShow = false
  private ready: Promise<void> | null = null
  private field: Field | null = null
  private state: AutofillState | null = null
  private height = 0
  private offer: PendingSave | null = null
  private saving: Omit<PendingSave, 'timer'> | null = null
  private hideTimer: NodeJS.Timeout | null = null
  private readonly watched = new WeakSet<WebContents>()
  /** A password Zepper suggested, saved without asking once you use it. */
  private generated: { origin: string; password: string } | null = null
  /** The passkey sheet's request (create, or sign in). */
  private sheet: Ticket | null = null
  /** Pages waiting to offer passkeys in the dropdown (mediation: "conditional"). */
  private readonly conditional = new Map<WebContents, Ticket>()
  /** A passkey request being answered by a phone (QR code, Bluetooth, tunnel). */
  private phone: HybridSession | null = null

  constructor(
    private readonly host: AutofillHost,
    private readonly vault: Vault
  ) {
    host.win.on('resize', () => this.hide())
  }

  /** The popup while it's showing, and where it is in the window. */
  visible(): { webContents: WebContents; bounds: Rect } | null {
    const popup = this.livePopup()
    return this.state && popup?.isVisible() ? { webContents: popup.webContents, bounds: this.bounds } : null
  }

  webContents(): WebContents | null {
    return this.livePopup()?.webContents ?? null
  }

  /** A message from a page's sign-in field. */
  onPageMessage(wc: WebContents, frame: WebFrameMain | null, message: PageMessage): void {
    if (!frame) return
    switch (message.type) {
      case 'focus':
        if (message.rect) this.openFor(wc, frame, message.field, message.rect, message.pointer ?? null)
        return
      case 'blur':
        return this.scheduleHide()
      case 'key':
        if (this.field?.wc === wc && this.state?.kind === 'list') this.send({ type: 'autofill.key', key: message.key })
        return
      case 'submit':
        return this.noteSubmit(wc, frame.url, String(message.username ?? ''), String(message.password ?? ''))
    }
  }

  handle(command: Command): void {
    switch (command.type) {
      case 'autofill.choose':
        return void this.choose(command.index)
      case 'autofill.save':
        return this.answerSave(command.choice)
      case 'autofill.dismiss':
        return this.dismiss()
      case 'autofill.resize':
        this.height = Math.max(0, Math.min(600, Math.round(command.height)))
        return this.position()
      case 'autofill.manage':
        this.close()
        return this.host.openPasswordSettings()
      case 'autofill.passkeyCreate':
        return void this.createPasskey()
      case 'autofill.passkeyChoose':
        return void this.usePasskey(command.id)
      case 'autofill.passkeyOther':
        return void this.otherDevice()
      case 'autofill.passkeyPhone':
        return void this.usePhone()
    }
  }

  /** Hides the dropdown (switching tabs, opening a panel). A save prompt or passkey sheet stays. */
  hide(): void {
    if (this.state?.kind === 'list') this.close()
  }

  destroy(): void {
    this.clearOffer()
    this.saving = null
    if (this.sheet) this.finish(this.sheet, NOT_ALLOWED)
    for (const ticket of this.conditional.values()) ticket.resolve(NOT_ALLOWED)
    this.conditional.clear()
    this.livePopup()?.destroy()
    this.popup = null
  }

  // ---------------------------------------------------------------------------
  // The dropdown

  private openFor(
    wc: WebContents,
    frame: WebFrameMain,
    kind: FieldKind,
    rect: [number, number, number, number],
    pointer: [number, number, number, number] | null
  ): void {
    if (!this.host.ownsVisiblePage(wc) || this.sheet) return
    const url = frame.url
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (!secureForPasswords(parsed)) return
    const bounds = this.host.pageBounds(wc)
    if (!bounds) return
    const zoom = wc.getZoomFactor()
    const [left, top, width, height] = rect.map((n) => Number(n) || 0)
    // Where the frame's viewport starts in the window: the page's own, or (for an iframe) worked out
    // from a pointer event's screen and client positions.
    let originX = bounds.x
    let originY = bounds.y
    if (frame !== wc.mainFrame) {
      if (!pointer) return
      const [screenX, screenY, clientX, clientY] = pointer.map((n) => Number(n) || 0)
      const content = this.host.win.getContentBounds()
      originX = screenX - clientX * zoom - content.x
      originY = screenY - clientY * zoom - content.y
      if (originX < bounds.x - 2 || originY < bounds.y - 2 || originX > bounds.x + bounds.width || originY > bounds.y + bounds.height)
        return
    }
    const anchor = { x: originX + left * zoom, y: originY + top * zoom, width: width * zoom, height: height * zoom }
    // Off the visible page (scrolled away or tiny): nothing to anchor to.
    if (anchor.y + anchor.height < bounds.y || anchor.y > bounds.y + bounds.height || anchor.width < 20) return
    this.cancelHide()
    this.field = { wc, frame, kind, origin: parsed.origin, url, anchor }
    this.watch(wc)

    const items: AutofillItem[] = []
    const passwords = this.host.settings().passwords
    if (kind === 'new-password') {
      if (passwords) items.push({ kind: 'generate', password: strongPassword() })
    } else {
      // Passkeys the page is ready to accept come first, as other browsers list them.
      const waiting = frame === wc.mainFrame ? this.conditional.get(wc) : undefined
      if (waiting && kind === 'username') {
        const allowed = (waiting.request.allowCredentials ?? []).map((d) => d.id)
        for (const passkey of this.vault.passkeysFor(waiting.request.rpId, allowed)) {
          items.push({ kind: 'passkey', id: passkey.id, username: passkey.userName || passkey.displayName, site: passkey.rpId })
        }
      }
      if (passwords) for (const login of this.vault.loginsFor(url)) items.push({ kind: 'login', ...login })
    }
    if (items.length === 0) return this.close()
    this.show({ kind: 'list', host: parsed.hostname.replace(/^www\./, ''), items })
  }

  private async choose(index: number): Promise<void> {
    const field = this.field
    const item = this.state?.kind === 'list' ? this.state.items[index] : undefined
    this.close()
    if (!field || !item || field.wc.isDestroyed()) return
    // The page may have moved on since the list opened: only fill the page it was opened for.
    if (frameOrigin(field.frame) !== field.origin) return
    if (item.kind === 'login') {
      // Only a login offered for this page, whatever the request says.
      const offered = this.vault.loginsFor(field.url).some((login) => login.id === item.id)
      const login = offered ? this.vault.login(item.id) : undefined
      if (!login) return
      this.vault.usedLogin(login.id)
      field.wc.focus()
      field.frame.send(FILL_CHANNEL, { username: login.username, password: login.password })
    } else if (item.kind === 'generate') {
      this.generated = { origin: field.origin, password: item.password }
      field.wc.focus()
      field.frame.send(FILL_CHANNEL, { password: item.password, allPasswords: true })
    } else {
      const ticket = this.conditional.get(field.wc)
      if (ticket) await this.signIn(ticket, item.id)
    }
  }

  // ---------------------------------------------------------------------------
  // Saving

  /** A sign-in form was sent: offer to save once the page moves on (a failed sign-in usually doesn't). */
  private noteSubmit(wc: WebContents, url: string, username: string, password: string): void {
    if (!this.host.settings().passwords || !password || password.length > 512 || username.length > 512) return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (!secureForPasswords(parsed)) return
    if (this.host.settings().neverSavePasswords.includes(siteOf(parsed.hostname))) return
    this.clearOffer()
    const timer = setTimeout(() => this.clearOffer(), SAVE_WAIT_MS)
    this.offer = { wc, url, username, password, timer }
    this.watch(wc)
  }

  /** The page with a pending save offer navigated: the sign-in went through. */
  private pageMovedOn(wc: WebContents): void {
    const offer = this.offer
    if (!offer || offer.wc !== wc) return
    this.clearOffer()
    const host = new URL(offer.url).hostname.replace(/^www\./, '')
    // A password Zepper suggested is saved straight away.
    if (this.generated?.origin === new URL(offer.url).origin && this.generated.password === offer.password) {
      this.generated = null
      if (this.vault.saveLogin(offer.url, offer.username, offer.password) && this.host.ownsVisiblePage(wc)) {
        this.saving = null
        this.field = null
        this.show({ kind: 'saved', host, username: offer.username })
        setTimeout(() => this.state?.kind === 'saved' && this.close(), 3000)
      }
      return
    }
    const existing = this.vault.findLogin(offer.url, offer.username)
    if (existing?.password === offer.password || !this.host.ownsVisiblePage(wc)) return
    this.saving = { wc, url: offer.url, username: offer.username, password: offer.password }
    this.field = null
    this.show({ kind: 'save', host, username: offer.username, update: Boolean(existing) })
    // Unanswered prompts don't keep the password around.
    setTimeout(() => {
      if (this.state?.kind === 'save' && this.saving?.password === offer.password) this.answerSave('later')
    }, 60_000)
  }

  private answerSave(choice: 'save' | 'later' | 'never'): void {
    const saving = this.saving
    this.saving = null
    this.close()
    if (!saving) return
    if (choice === 'never') {
      const domain = siteOf(new URL(saving.url).hostname)
      const list = this.host.settings().neverSavePasswords
      if (!list.includes(domain)) this.host.updateSettings({ neverSavePasswords: [...list, domain] })
    } else if (choice === 'save') {
      this.vault.saveLogin(saving.url, saving.username, saving.password)
    }
  }

  private clearOffer(): void {
    if (this.offer) clearTimeout(this.offer.timer)
    this.offer = null
  }

  // ---------------------------------------------------------------------------
  // Passkeys

  /** A page's navigator.credentials request; resolves with the reply the page's shim expects. */
  requestPasskey(wc: WebContents, frame: WebFrameMain, kind: 'create' | 'get', options: Record<string, unknown>): Promise<string> {
    let request: PasskeyRequest
    try {
      request = checkRequest(frame, kind, options)
    } catch (error) {
      return Promise.resolve(replyFor(error))
    }
    return new Promise((resolve) => {
      const ticket: Ticket = { wc, request, resolve, timer: null }
      this.watch(wc)
      if (request.conditional) {
        // Offered in the dropdown under the page's username field until the page gives up.
        this.conditional.get(wc)?.resolve(failure('AbortError', 'Replaced by a newer request.'))
        this.conditional.set(wc, ticket)
        return
      }
      if (!this.host.ownsVisiblePage(wc)) return resolve(failure('NotAllowedError', 'The document is not focused.'))
      if (this.sheet) return resolve(failure('NotAllowedError', 'A request is already pending.'))
      ticket.timer = setTimeout(() => this.finish(ticket, NOT_ALLOWED), PASSKEY_TIMEOUT_MS)
      this.sheet = ticket
      const other = systemPasskeysAvailable()
      if (kind === 'create') {
        // Zepper's passkeys are ES256; anything else can only go to macOS.
        if (!request.algorithms?.includes(-7)) {
          return other
            ? void this.otherDevice()
            : this.finish(ticket, failure('NotSupportedError', 'None of the requested algorithms are supported.'))
        }
        const saved = new Set(this.vault.passkeysFor(request.rpId).map((p) => p.id))
        if (request.excludeCredentials?.some((d) => saved.has(d.id))) {
          return this.finish(ticket, failure('InvalidStateError', 'The authenticator was previously registered.'))
        }
        this.field = null
        this.show({ kind: 'passkeyCreate', rpId: request.rpId, userName: request.user?.name || request.user?.displayName || '', other })
      } else {
        const allowed = (request.allowCredentials ?? []).map((d) => d.id)
        const passkeys = this.vault
          .passkeysFor(request.rpId, allowed)
          .map((p) => ({ id: p.id, userName: p.userName, displayName: p.displayName }))
        this.field = null
        this.show({ kind: 'passkeyGet', rpId: request.rpId, passkeys, other })
      }
    })
  }

  /** The page aborted its request (or went away). */
  cancelPasskey(wc: WebContents): void {
    const waiting = this.conditional.get(wc)
    if (waiting) {
      this.conditional.delete(wc)
      waiting.resolve(failure('AbortError', 'The operation was aborted.'))
    }
    if (this.sheet?.wc === wc) {
      cancelSystemPasskey()
      this.finish(this.sheet, failure('AbortError', 'The operation was aborted.'))
    }
  }

  private finish(ticket: Ticket, reply: string): void {
    if (ticket.timer) clearTimeout(ticket.timer)
    if (this.sheet === ticket) {
      this.sheet = null
      this.phone?.cancel()
      this.phone = null
      if (this.state?.kind === 'passkeyCreate' || this.state?.kind === 'passkeyGet' || this.state?.kind === 'passkeyPhone') this.close()
    }
    for (const [wc, waiting] of this.conditional) if (waiting === ticket) this.conditional.delete(wc)
    ticket.resolve(reply)
  }

  /** Touch ID (or your password) when the site asks for verification; null if you didn't confirm. */
  private async verify(preference: Verification, reason: string): Promise<boolean | null> {
    if (preference === 'discouraged') return false
    const result = await verifyOwner(reason).catch(() => false as const)
    if (result === true) return true
    if (result === 'unavailable') return preference === 'required' ? null : false
    return null
  }

  private async createPasskey(): Promise<void> {
    const ticket = this.sheet
    if (!ticket || ticket.request.kind !== 'create' || !ticket.request.user) return
    const { request } = ticket
    this.close()
    const verified = await this.verify(request.userVerification, `save a passkey for ${request.rpId}`)
    if (verified === null) return this.finish(ticket, NOT_ALLOWED)
    const { record, response } = makeCredential({ ...request, user: request.user!, verified })
    this.vault.addPasskey(record)
    this.finish(ticket, ok(response))
  }

  private async usePasskey(id: string): Promise<void> {
    const ticket = this.sheet
    if (!ticket || ticket.request.kind !== 'get') return
    this.close()
    await this.signIn(ticket, id)
  }

  /** Signs in with a saved passkey (from the sheet, or the dropdown for a waiting page). */
  private async signIn(ticket: Ticket, id: string): Promise<void> {
    const { request } = ticket
    const allowed = (request.allowCredentials ?? []).map((d) => d.id)
    const passkey = this.vault.passkeysFor(request.rpId, allowed).find((p) => p.id === id)
    if (!passkey) return this.finish(ticket, NOT_ALLOWED)
    const verified = await this.verify(request.userVerification, `sign in to ${request.rpId}`)
    if (verified === null) {
      // Turning down Touch ID in the dropdown leaves the page waiting, as if you'd closed the list.
      if (request.conditional) return
      return this.finish(ticket, NOT_ALLOWED)
    }
    this.finish(ticket, ok(getAssertion(this.vault, passkey, { ...request, verified })))
  }

  /** iCloud Keychain, a phone nearby or a security key, through macOS (with Apple's browser entitlement). */
  private async otherDevice(): Promise<void> {
    const ticket = this.sheet
    if (!ticket) return
    this.close()
    try {
      this.finish(ticket, ok(await systemPasskey(this.host.win, ticket.request)))
    } catch (error) {
      this.finish(ticket, replyFor(error))
    }
  }

  /** A phone's passkey: show a QR code to scan, then the phone does the rest (FIDO hybrid). */
  private async usePhone(): Promise<void> {
    const ticket = this.sheet
    if (!ticket || this.phone) return
    const { request } = ticket
    const session = new HybridSession(request)
    this.phone = session
    const render = (status: PhoneStatus, error?: string): void => {
      if (this.sheet !== ticket) return
      this.field = null
      this.show({ kind: 'passkeyPhone', rpId: request.rpId, create: request.kind === 'create', qr: session.qr, status, error })
    }
    session.onStatus = (status) => render(status)
    render('scan')
    try {
      this.finish(ticket, ok(await session.run()))
    } catch (error) {
      // Cancelled (Cancel, the page, or a timeout) has already been answered.
      if (session.cancelled) return
      // The phone's own answer (declined, no passkey, already registered) goes back to the site.
      if (error instanceof WebAuthnError) return this.finish(ticket, replyFor(error))
      render('error', error instanceof Error ? error.message : 'Your phone couldn’t complete the request.')
    } finally {
      if (this.phone === session) this.phone = null
    }
  }

  private dismiss(): void {
    if (this.phone) {
      this.phone.cancel()
      this.phone = null
    }
    if (this.sheet && (this.state?.kind === 'passkeyCreate' || this.state?.kind === 'passkeyGet' || this.state?.kind === 'passkeyPhone'))
      return this.finish(this.sheet, NOT_ALLOWED)
    if (this.state?.kind === 'save') return this.answerSave('later')
    this.close()
  }

  private watch(wc: WebContents): void {
    if (this.watched.has(wc)) return
    this.watched.add(wc)
    wc.on('did-start-navigation', (_e, _url, inPage, isMainFrame) => {
      if (!isMainFrame || inPage) return
      if (this.field?.wc === wc) this.hide()
      // A new page: requests from the old one are over.
      const waiting = this.conditional.get(wc)
      if (waiting) this.finish(waiting, failure('AbortError', 'The page navigated.'))
      if (this.sheet?.wc === wc) this.finish(this.sheet, NOT_ALLOWED)
    })
    wc.on('did-navigate', () => this.pageMovedOn(wc))
    wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => isMainFrame && this.pageMovedOn(wc))
    wc.once('destroyed', () => {
      if (this.field?.wc === wc) this.close()
      if (this.offer?.wc === wc) this.clearOffer()
      this.conditional.delete(wc)
      if (this.sheet?.wc === wc) this.finish(this.sheet, NOT_ALLOWED)
    })
  }

  // ---------------------------------------------------------------------------
  // The popup: a small borderless child window, so it gets a real macOS shadow, can hang over the
  // window's edge, and never takes focus from the page.

  private show(state: AutofillState): void {
    this.cancelHide()
    this.state = state
    const popup = this.ensurePopup()
    void this.ready?.then(() => {
      if (this.state !== state || popup.isDestroyed()) return
      // Shown once the page reports its height for this state (see 'autofill.resize'), or soon anyway at the last one.
      this.pendingShow = true
      this.send({ type: 'autofill.show', state, dark: nativeTheme.shouldUseDarkColors })
      this.setPageDropdown(state.kind === 'list')
      setTimeout(() => this.state === state && this.pendingShow && this.position(), 150)
    })
  }

  private close(): void {
    this.cancelHide()
    this.setPageDropdown(false)
    this.state = null
    this.pendingShow = false
    this.livePopup()?.hide()
  }

  /** The field lost focus: close the dropdown soon (the popup itself never takes focus). */
  private scheduleHide(): void {
    this.cancelHide()
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null
      if (this.state?.kind === 'list') this.close()
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
      // It's hidden between uses; it must still render then, to report its size before it's shown.
      webPreferences: { ...this.host.uiPreferences, backgroundThrottling: false }
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
    if (state.kind === 'list' && this.field) {
      const { anchor } = this.field
      width = Math.min(380, Math.max(260, anchor.width))
      x = anchor.x
      y = anchor.y + anchor.height + 4
      // No room below: open above the field.
      if (y + height > winHeight) y = Math.max(0, anchor.y - 4 - height)
    } else {
      const wc = this.sheet?.wc ?? this.saving?.wc
      const page = (wc && !wc.isDestroyed() && this.host.pageBounds(wc)) || this.windowBounds()
      width = SHEET_WIDTH
      if (state.kind === 'passkeyCreate' || state.kind === 'passkeyGet' || state.kind === 'passkeyPhone') {
        // Passkey sheets drop from the top centre of the page, like other browsers'.
        x = page.x + (page.width - width) / 2
      } else {
        // Save prompts sit at the top right.
        x = page.x + page.width - width - 10
      }
      y = page.y + 10
    }
    x = Math.round(Math.max(0, Math.min(x, winWidth - width)))
    this.bounds = { x, y: Math.round(y), width: Math.round(width), height: Math.round(height) }
    const content = this.host.win.getContentBounds()
    popup.setBounds({ ...this.bounds, x: content.x + this.bounds.x, y: content.y + this.bounds.y })
    if (this.pendingShow) {
      this.pendingShow = false
      popup.showInactive()
    }
    // The shadow follows the card's shape; recompute it once the new size has painted.
    setTimeout(() => this.livePopup()?.invalidateShadow(), 40)
  }

  private windowBounds(): Rect {
    const [width, height] = this.host.win.getContentSize()
    return { x: 0, y: 0, width, height }
  }
}

function replyFor(error: unknown): string {
  if (error instanceof WebAuthnError) return failure(error.domName, error.message)
  return NOT_ALLOWED
}

const siteOf = (host: string): string => parseDomain(host).domain ?? host

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
