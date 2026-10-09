import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse as parseDomain } from 'tldts-experimental'
import type { ImportResult, LoginSummary, PasskeySummary, SavedLogin } from '@shared/types'

/**
 * Zepper's password manager: saved passwords and passkeys, kept in a file per profile (each space's
 * own, or the default one) and
 * encrypted with the key Chromium keeps in the macOS Keychain (Electron's safeStorage). Nothing
 * here leaves the Mac. Passwords are matched to pages by origin, plus other pages of the same
 * site (accounts.example.com offers what you saved on example.com).
 *
 * The Keychain is only ever reached off the main thread (safeStorage's async calls): macOS can ask
 * you to allow it, and waiting for that on the main thread froze the whole browser. So the file is
 * read in the background as soon as its profile opens, and whatever uses it waits for `ready()`.
 */

export interface LoginRecord {
  id: string
  /** scheme://host[:port] */
  origin: string
  username: string
  password: string
  note: string
  created: number
  updated: number
  lastUsed: number | null
}

export interface PasskeyRecord {
  /** The credential ID, base64url. */
  id: string
  rpId: string
  /** The site's user handle, base64url. */
  userHandle: string
  userName: string
  displayName: string
  /** The private key, PKCS #8 DER, base64. */
  privateKey: string
  /** COSE algorithm (-7: ES256). */
  alg: number
  created: number
  lastUsed: number | null
}

interface Contents {
  version: 1
  logins: LoginRecord[]
  passkeys: PasskeyRecord[]
}

export interface ImportEntry {
  url: string
  username: string
  password: string
  note?: string
  created?: number
}

const FILE = 'passwords.vault'

/** The origin a login belongs to, for pages and imported URLs (null for anything that isn't a web address). */
export function loginOrigin(url: string): string | null {
  try {
    const parsed = new URL(url.includes('://') ? url : `https://${url}`)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    if (!parsed.hostname) return null
    return parsed.origin
  } catch {
    return null
  }
}

const hostOf = (origin: string): string => new URL(origin).host
const siteOf = (host: string): string => parseDomain(host).domain ?? host

export class Vault {
  private readonly path: string
  private data: Contents = { version: 1, logins: [], passkeys: [] }
  /** Reading the file (see ready). */
  private loading: Promise<void> | null = null
  private loaded = false
  /**
   * The file is there but its key isn't: macOS didn't give Zepper its Keychain key this time (you
   * chose Deny). The file is left as it is, and nothing is saved over it until Zepper is reopened.
   */
  private locked = false
  private discarded = false
  /** The contents still to write (the latest; older ones are skipped) and the writes under way, in order. */
  private unsaved: string | null = null
  private writing: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  /** `name`: the file, in the user data folder (each profile has its own). */
  constructor(name = FILE) {
    this.path = join(app.getPath('userData'), name)
  }

  /** Read (in the background, from when its profile opens): wait for it before using the vault. */
  ready(): Promise<void> {
    return (this.loading ??= this.load())
  }

  /** Whether macOS kept the key from Zepper (see `locked`): the saved passwords can't be shown or added to. */
  get unavailable(): boolean {
    return this.locked
  }

  /** Read, and saved to: nothing is added while it isn't (it would be lost, or written over the file). */
  private get writable(): boolean {
    return this.loaded && !this.locked && !this.discarded
  }

  /**
   * Adds another vault's passwords and passkeys that this one doesn't have (the same account on the
   * same site, or the same passkey, is kept as it is here). Returns how many came over, or null if
   * either couldn't be opened (nothing moved).
   */
  async mergeFrom(other: Vault): Promise<number | null> {
    await Promise.all([this.ready(), other.ready()])
    if (this.locked || other.locked) return null
    const theirs = other.contents()
    if (theirs.logins.length === 0 && theirs.passkeys.length === 0) return 0
    const data = this.contents()
    const accounts = new Set(data.logins.map((login) => `${login.origin} ${login.username}`))
    const keys = new Set(data.passkeys.map((passkey) => passkey.id))
    const logins = theirs.logins.filter((login) => !accounts.has(`${login.origin} ${login.username}`))
    const passkeys = theirs.passkeys.filter((passkey) => !keys.has(passkey.id))
    if (logins.length + passkeys.length === 0) return 0
    data.logins.push(...logins.map((login) => ({ ...login, id: randomUUID() })))
    data.passkeys.push(...passkeys.map((passkey) => ({ ...passkey })))
    this.save()
    return logins.length + passkeys.length
  }

  /** Deletes the file (a profile nothing uses any more), once any save under way is done. */
  discard(): Promise<void> {
    this.data = { version: 1, logins: [], passkeys: [] }
    this.loaded = true
    this.discarded = true
    this.unsaved = null
    for (const listener of this.listeners) listener()
    this.writing = this.writing.then(() => rm(this.path, { force: true })).catch(() => {})
    return this.writing
  }

  /** Waits for the saves under way (before quitting). */
  written(): Promise<void> {
    return this.writing
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ---- Passwords ----

  /** Saved logins offered on a page: this origin's first, then the rest of the site. */
  loginsFor(url: string): SavedLogin[] {
    const origin = loginOrigin(url)
    if (!origin) return []
    const page = new URL(origin)
    const site = siteOf(page.hostname)
    const matches = this.contents().logins.filter((login) => {
      if (login.origin === origin) return true
      const saved = new URL(login.origin)
      // An http login is offered on the https page of the same host, never the other way round.
      if (saved.host === page.host) return saved.protocol === 'http:' && page.protocol === 'https:'
      return saved.protocol === page.protocol && siteOf(saved.hostname) === site
    })
    const rank = (login: LoginRecord): number => (login.origin === origin ? 0 : 1)
    return matches
      .sort((a, b) => rank(a) - rank(b) || (b.lastUsed ?? b.updated) - (a.lastUsed ?? a.updated))
      .map((login) => ({ id: login.id, username: login.username, site: hostOf(login.origin) }))
  }

  login(id: string): LoginRecord | undefined {
    return this.contents().logins.find((login) => login.id === id)
  }

  findLogin(url: string, username: string): LoginRecord | undefined {
    const origin = loginOrigin(url)
    return origin ? this.contents().logins.find((login) => login.origin === origin && login.username === username) : undefined
  }

  /** Saves a login from a page (updating the password if this account is already saved there). */
  saveLogin(url: string, username: string, password: string): LoginRecord | null {
    const origin = loginOrigin(url)
    if (!origin || !password || !this.writable) return null
    const now = Date.now()
    const existing = this.findLogin(origin, username)
    if (existing) {
      existing.password = password
      existing.updated = now
      existing.lastUsed = now
      this.save()
      return existing
    }
    const login: LoginRecord = { id: randomUUID(), origin, username, password, note: '', created: now, updated: now, lastUsed: now }
    this.contents().logins.push(login)
    this.save()
    return login
  }

  updateLogin(id: string, patch: { username?: string; password?: string; url?: string; note?: string }): string | null {
    const login = this.login(id)
    if (!login) return 'That password is no longer saved.'
    const origin = patch.url !== undefined ? loginOrigin(patch.url) : login.origin
    if (!origin) return 'Enter a website address, like example.com.'
    if (patch.password !== undefined && !patch.password) return 'The password can’t be empty.'
    const username = patch.username ?? login.username
    const clash = this.contents().logins.find((l) => l.id !== id && l.origin === origin && l.username === username)
    if (clash) return 'That account is already saved for this site.'
    Object.assign(login, { origin, username, updated: Date.now() })
    if (patch.password !== undefined) login.password = patch.password
    if (patch.note !== undefined) login.note = patch.note
    this.save()
    return null
  }

  deleteLogin(id: string): void {
    const data = this.contents()
    data.logins = data.logins.filter((login) => login.id !== id)
    this.save()
  }

  /** A login was just filled: it moves up the list next time. */
  usedLogin(id: string): void {
    const login = this.login(id)
    if (!login) return
    login.lastUsed = Date.now()
    this.save()
  }

  listLogins(): LoginSummary[] {
    return this.contents()
      .logins.map((login) => ({
        id: login.id,
        origin: login.origin,
        host: hostOf(login.origin),
        username: login.username,
        note: login.note,
        updated: login.updated,
        lastUsed: login.lastUsed
      }))
      .sort((a, b) => a.host.replace(/^www\./, '').localeCompare(b.host.replace(/^www\./, '')) || a.username.localeCompare(b.username))
  }

  /** Adds imported logins: exact duplicates are skipped, and a different password for a saved account keeps yours. */
  importLogins(entries: ImportEntry[]): ImportResult {
    const result: ImportResult = { added: 0, skipped: 0, conflicts: 0, invalid: 0 }
    if (!this.writable) return result
    const data = this.contents()
    const now = Date.now()
    for (const entry of entries) {
      const origin = loginOrigin(entry.url.trim())
      if (!origin || !entry.password) {
        result.invalid++
        continue
      }
      const username = entry.username.trim()
      const existing = data.logins.find((login) => login.origin === origin && login.username === username)
      if (existing) {
        if (existing.password === entry.password) result.skipped++
        else result.conflicts++
        continue
      }
      const created = entry.created && entry.created > 0 && entry.created < now ? entry.created : now
      data.logins.push({
        id: randomUUID(),
        origin,
        username,
        password: entry.password,
        note: entry.note?.trim() ?? '',
        created,
        updated: created,
        lastUsed: null
      })
      result.added++
    }
    if (result.added > 0) this.save()
    return result
  }

  /** Every password as CSV, in the columns Chrome, Safari and most password managers import. */
  exportCsv(): string {
    const cell = (value: string): string => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
    const rows = this.contents().logins.map((login) =>
      [hostOf(login.origin), `${login.origin}/`, login.username, login.password, login.note].map(cell).join(',')
    )
    return ['name,url,username,password,note', ...rows].join('\n') + '\n'
  }

  // ---- Passkeys ----

  /** Passkeys for a relying party (only those listed, when the site names them). */
  passkeysFor(rpId: string, allowed: string[] = []): PasskeyRecord[] {
    return this.contents()
      .passkeys.filter((passkey) => passkey.rpId === rpId && (allowed.length === 0 || allowed.includes(passkey.id)))
      .sort((a, b) => (b.lastUsed ?? b.created) - (a.lastUsed ?? a.created))
  }

  passkey(id: string): PasskeyRecord | undefined {
    return this.contents().passkeys.find((passkey) => passkey.id === id)
  }

  /** Saves a new passkey; one already saved for the same account on the site is replaced, as other platforms do. */
  addPasskey(passkey: PasskeyRecord): void {
    if (!this.writable) return
    const data = this.contents()
    data.passkeys = data.passkeys.filter((p) => !(p.rpId === passkey.rpId && p.userHandle === passkey.userHandle))
    data.passkeys.push(passkey)
    this.save()
  }

  usedPasskey(id: string): void {
    const passkey = this.passkey(id)
    if (!passkey) return
    passkey.lastUsed = Date.now()
    this.save()
  }

  deletePasskey(id: string): void {
    const data = this.contents()
    data.passkeys = data.passkeys.filter((passkey) => passkey.id !== id)
    this.save()
  }

  listPasskeys(): PasskeySummary[] {
    return this.contents()
      .passkeys.map((p) => ({
        id: p.id,
        rpId: p.rpId,
        userName: p.userName,
        displayName: p.displayName,
        created: p.created,
        lastUsed: p.lastUsed
      }))
      .sort((a, b) => a.rpId.localeCompare(b.rpId) || a.userName.localeCompare(b.userName))
  }

  // ---- Storage ----

  /** What's been read so far (nothing until `ready()`). */
  private contents(): Contents {
    return this.data
  }

  private async load(): Promise<void> {
    await app.whenReady()
    let encrypted: Buffer
    try {
      encrypted = await readFile(this.path)
    } catch {
      // Nothing saved yet.
      this.loaded = true
      return
    }
    if (this.discarded) return
    try {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encrypted)
      if (this.discarded) return
      const parsed = JSON.parse(result) as Partial<Contents>
      this.data = { version: 1, logins: parsed.logins ?? [], passkeys: parsed.passkeys ?? [] }
      this.loaded = true
      if (shouldReEncrypt) this.save()
    } catch (error) {
      if (this.discarded) return
      if (/temporarily unavailable/i.test(error instanceof Error ? error.message : String(error))) {
        // No key this time (Keychain access refused): the passwords are still there for next time.
        console.warn('[passwords] the Keychain key is unavailable; leaving the vault as it is')
        this.locked = true
        return
      }
      // The key doesn't open it (the Keychain item was replaced) or the file is damaged: keep the file
      // aside rather than overwrite it.
      console.warn('[passwords] could not read the vault', error)
      await rename(this.path, `${this.path}.unreadable-${Date.now()}`).catch(() => {})
      this.loaded = true
    }
    for (const listener of this.listeners) listener()
  }

  /** Writes the contents (in the background, encrypted off the main thread), after any save before it. */
  private save(): void {
    for (const listener of this.listeners) listener()
    if (!this.writable) {
      console.warn('[passwords] the vault isn’t open; not saving')
      return
    }
    this.unsaved = JSON.stringify(this.data)
    this.writing = this.writing
      .then(async () => {
        const json = this.unsaved
        this.unsaved = null
        if (json === null || this.discarded) return
        const encrypted = await safeStorage.encryptStringAsync(json)
        await mkdir(dirname(this.path), { recursive: true })
        const tmp = `${this.path}.tmp`
        await writeFile(tmp, encrypted, { mode: 0o600 })
        await rename(tmp, this.path)
      })
      .catch((error) => console.warn('[passwords] could not save', error))
  }
}
