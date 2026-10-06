import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { SavedLogin } from '@shared/types'
import type { PasswordStore, StoreStatus } from './autofill'

/**
 * Apple Passwords (iCloud Keychain), through the helper macOS ships for browsers. It's the same
 * helper Apple's own browser extension uses, spoken to directly: Chrome-style native messaging
 * over stdin and stdout, a one-time pairing code (SRP-6a) per app session, then AES-GCM sealed
 * requests. macOS only lets approved browsers start the helper (signed with Apple's browser
 * entitlement); anywhere else it's stopped at launch, and passwords simply stay off.
 */

const MANIFESTS = [
  '/Library/Google/Chrome/NativeMessagingHosts/com.apple.passwordmanager.json',
  '/Library/Application Support/Mozilla/NativeMessagingHosts/com.apple.passwordmanager.json'
]
const FALLBACK_HELPER =
  '/System/Cryptexes/App/System/Library/CoreServices/PasswordManagerBrowserExtensionHelper.app/Contents/MacOS/PasswordManagerBrowserExtensionHelper'
/** The helper only uses this to word its own windows; any allowed origin works. */
const HELPER_ARGUMENT = 'chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/'

const enum Cmd {
  End = 0,
  Handshake = 2,
  GetLoginNames = 4,
  GetPassword = 5,
  SetPassword = 6,
  NewAccount = 7,
  PasswordsDisabled = 9,
  ReloginNeeded = 10,
  OpenPasswordsApp = 13,
  Hello = 14,
  CancelPairing = 19
}

const STATUS_MESSAGES: Record<number, string> = {
  1: 'Apple Passwords couldn’t do that.',
  3: 'No saved passwords.',
  5: 'Apple Passwords couldn’t update that password.',
  9: 'Apple Passwords disconnected. Connect again.'
}

// RFC 5054's 3072-bit group, as Apple's extension uses it.
const N = BigInt(
  '0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D876027333EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF'
)
const G = 5n
const N_BYTES = 384

const sha256 = (...parts: (Buffer | string)[]): Buffer => {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest()
}

/** Big-endian bytes, without leading zeros. */
function bytes(n: bigint): Buffer {
  let hex = n.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  return Buffer.from(hex, 'hex')
}

const padded = (n: bigint): Buffer => {
  const b = bytes(n)
  return b.length >= N_BYTES ? b : Buffer.concat([Buffer.alloc(N_BYTES - b.length), b])
}

const toBigInt = (b: Buffer): bigint => (b.length === 0 ? 0n : BigInt(`0x${b.toString('hex')}`))

const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m

function powmod(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  base = mod(base, modulus)
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus
    exponent >>= 1n
    base = (base * base) % modulus
  }
  return result
}

/** One pairing with the helper: SRP-6a with Apple's RFC-style verification, then AES-128-GCM. */
class SecretSession {
  /** A random session identity (TID), sent and hashed as this exact string. */
  readonly tid: string
  private readonly a = toBigInt(randomBytes(32))
  readonly A = powmod(G, this.a, N)
  private salt: Buffer | null = null
  private B = 0n
  private key: Buffer | null = null
  private M: Buffer | null = null
  private K: Buffer | null = null

  constructor(private readonly base64: boolean) {
    const id = randomBytes(16)
    id[0] |= 0x80
    this.tid = this.encode(id)
  }

  get paired(): boolean {
    return this.key !== null
  }

  encode(data: Buffer, prefix = true): string {
    return this.base64 ? data.toString('base64') : `${prefix ? '0x' : ''}${data.toString('hex')}`
  }

  decode(text: string): Buffer {
    return this.base64 ? Buffer.from(text, 'base64') : Buffer.from(text.replace(/^0x/, ''), 'hex')
  }

  hello(): string {
    return pake({ TID: this.tid, MSG: 0, A: this.encode(bytes(this.A)), VER: '1.0', PROTO: [1] })
  }

  /** The helper's reply to hello: its public key and salt. */
  challenge(message: Record<string, unknown>): void {
    if (message['TID'] !== this.tid || Number(message['MSG']) !== 1) throw new Error('Unexpected reply from Apple Passwords.')
    if (message['PROTO'] !== undefined && Number(message['PROTO']) !== 1)
      throw new Error('This version of Apple Passwords isn’t supported.')
    this.salt = this.decode(String(message['s'] ?? ''))
    this.B = toBigInt(this.decode(String(message['B'] ?? '')))
    if (this.salt.length === 0 || mod(this.B, N) === 0n) throw new Error('Unexpected reply from Apple Passwords.')
  }

  /** Proves knowledge of the code macOS shows, deriving the session key. */
  proof(pin: string): string {
    const salt = this.salt
    if (!salt) throw new Error('Not connecting.')
    const x = toBigInt(sha256(salt, sha256(`${this.tid}:${pin}`)))
    const v = powmod(G, x, N)
    const k = toBigInt(sha256(bytes(N), padded(G)))
    const u = toBigInt(sha256(padded(this.A), padded(this.B)))
    const S = powmod(mod(this.B - k * v, N), this.a + u * x, N)
    const K = sha256(bytes(S))
    const hN = sha256(bytes(N))
    const hG = sha256(padded(G))
    for (let i = 0; i < hN.length; i++) hN[i] ^= hG[i]
    const M = sha256(hN, sha256(this.tid), salt, bytes(this.A), bytes(this.B), K)
    this.M = M
    this.K = K
    return pake({ TID: this.tid, MSG: 2, M: this.encode(M, false) })
  }

  /** The helper accepted the code (and proved it has the same key). */
  confirm(message: Record<string, unknown>): void {
    if (message['TID'] !== this.tid || Number(message['MSG']) !== 3) throw new Error('Unexpected reply from Apple Passwords.')
    const error = Number(message['ErrCode'] ?? 0)
    if (error === 1) throw new PairingError('That code didn’t work. Try the new one.')
    if (error !== 0) throw new PairingError('Apple Passwords didn’t accept the code. Try again.')
    const { M, K } = this
    if (!M || !K) throw new Error('Not connecting.')
    const expected = sha256(bytes(this.A), M, K)
    if (!expected.equals(this.decode(String(message['HAMK'] ?? ''))))
      throw new PairingError('Apple Passwords couldn’t be verified. Try again.')
    this.key = K.subarray(0, 16)
  }

  seal(data: unknown): string {
    if (!this.key) throw new Error('Not connected.')
    const iv = randomBytes(16)
    const cipher = createCipheriv('aes-128-gcm', this.key, iv)
    const sealed = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final(), cipher.getAuthTag(), iv])
    return JSON.stringify({ TID: this.tid, SDATA: this.encode(sealed, false) })
  }

  open(smsg: unknown): Record<string, unknown> {
    if (!this.key) throw new Error('Not connected.')
    const message = (typeof smsg === 'string' ? JSON.parse(smsg) : smsg) as { TID?: string; SDATA?: string }
    if (message?.TID !== this.tid || typeof message.SDATA !== 'string') throw new Error('Unexpected reply from Apple Passwords.')
    const data = this.decode(message.SDATA)
    const decipher = createDecipheriv('aes-128-gcm', this.key, data.subarray(0, 16))
    decipher.setAuthTag(data.subarray(data.length - 16))
    const plain = Buffer.concat([decipher.update(data.subarray(16, data.length - 16)), decipher.final()])
    return JSON.parse(plain.toString('utf8')) as Record<string, unknown>
  }
}

class PairingError extends Error {}

const pake = (message: unknown): string => Buffer.from(JSON.stringify(message), 'utf8').toString('base64')

interface Entry {
  USR?: string
  PWD?: string
  sites?: string[]
}

export class ApplePasswords implements PasswordStore {
  /** Saving goes through the helper, which asks you itself ("Save Password?"). */
  readonly confirmsSaves = true
  private helper: ChildProcessWithoutNullStreams | null = null
  private buffer = Buffer.alloc(0)
  private readonly waiting: { cmds: number[]; resolve: (message: Record<string, unknown>) => void; reject: (error: Error) => void }[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private session: SecretSession | null = null
  private base64 = true
  /** Why the helper can't be used on this Mac (set once; it doesn't change while Zepper runs). */
  private unavailable: string | null = null
  private startedAt = 0

  async status(): Promise<StoreStatus> {
    if (this.unavailable) return { state: 'unavailable', reason: this.unavailable }
    if (this.session?.paired && this.helper) return { state: 'ready' }
    try {
      await this.start()
    } catch (error) {
      return { state: 'unavailable', reason: this.unavailable ?? (error instanceof Error ? error.message : String(error)) }
    }
    return this.session?.paired ? { state: 'ready' } : { state: 'connect' }
  }

  async logins(url: string): Promise<SavedLogin[]> {
    const host = hostOf(url)
    const reply = await this.secure(Cmd.GetLoginNames, 'CmdGetLoginNames4URL', host, { ACT: 5, URL: host }, 8000)
    const seen = new Set<string>()
    return entries(reply).flatMap((entry) => {
      const username = entry.USR ?? ''
      // "Passwords not saved" marks a site you told Apple Passwords never to save.
      if (username === 'Passwords not saved' || seen.has(username)) return []
      seen.add(username)
      return [{ id: username, username, site: entry.sites?.[0]?.replace(/^https?:\/\//, '').replace(/\/$/, '') || host }]
    })
  }

  async password(url: string, id: string): Promise<{ username: string; password: string } | null> {
    const host = hostOf(url)
    // macOS may ask for Touch ID or your password first, so there's no time limit.
    const reply = await this.secure(Cmd.GetPassword, 'CmdGetPassword4LoginName', host, { ACT: 2, URL: host, USR: id }, null)
    const entry = entries(reply).find((e) => (e.USR ?? '') === id) ?? entries(reply)[0]
    return entry && typeof entry.PWD === 'string' ? { username: entry.USR ?? id, password: entry.PWD } : null
  }

  async save(url: string, username: string, password: string): Promise<void> {
    const host = hostOf(url)
    await this.secure(
      Cmd.SetPassword,
      'CmdSetPassword4LoginName_URL',
      host,
      { ACT: 4, URL: '', USR: '', PWD: '', NURL: host, NUSR: username, NPWD: password },
      null,
      [Cmd.SetPassword, Cmd.GetLoginNames, Cmd.NewAccount]
    )
  }

  async startPairing(): Promise<void> {
    await this.start()
    this.session = new SecretSession(this.base64)
    const session = this.session
    const reply = await this.request(
      { cmd: Cmd.Handshake, msg: JSON.stringify({ QID: 'm0', PAKE: session.hello(), HSTBRSR: 'Zepper' }) },
      10_000
    )
    session.challenge(readPake(reply))
  }

  async finishPairing(pin: string): Promise<void> {
    const session = this.session
    if (!session) throw new Error('Not connecting.')
    try {
      const reply = await this.request({ cmd: Cmd.Handshake, msg: JSON.stringify({ QID: 'm2', PAKE: session.proof(pin) }) }, 10_000)
      session.confirm(readPake(reply))
    } catch (error) {
      // A wrong code ends this attempt; macOS shows a new one for the next.
      if (error instanceof PairingError) await this.startPairing().catch(() => {})
      throw error
    }
  }

  cancelPairing(): void {
    if (this.session && !this.session.paired) {
      this.session = null
      this.write({ cmd: Cmd.CancelPairing })
    }
  }

  openPasswordsApp(): void {
    if (this.helper && this.session?.paired) this.write({ cmd: Cmd.OpenPasswordsApp })
  }

  stop(): void {
    if (!this.helper) return
    this.write({ cmd: Cmd.End })
    this.helper.stdin.end()
    this.helper = null
  }

  // ---------------------------------------------------------------------------

  /** Starts the helper and says hello (once per app session; pairing lives as long as it runs). */
  private async start(): Promise<void> {
    if (this.helper) return
    if (process.platform !== 'darwin') {
      this.unavailable = 'Apple Passwords needs macOS.'
      throw new Error(this.unavailable)
    }
    const path = helperPath()
    if (!path) {
      this.unavailable = 'Apple Passwords needs macOS 14 or later.'
      throw new Error(this.unavailable)
    }
    // Spawned directly (no shell): macOS checks that the app starting it is an approved browser.
    const helper = spawn(path, [HELPER_ARGUMENT], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.helper = helper
    this.startedAt = Date.now()
    helper.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    helper.stderr.on('data', () => {})
    helper.on('error', (error) => this.stopped(error.message))
    helper.on('exit', (code, signal) => {
      // Stopped by macOS right away: this build of Zepper isn't signed as an approved browser.
      if (signal === 'SIGKILL' && Date.now() - this.startedAt < 3000) {
        this.unavailable = 'This build of Zepper isn’t signed with Apple’s browser entitlement, so macOS won’t let it use Apple Passwords.'
      }
      this.stopped(`Apple Passwords stopped (${signal ?? code}).`)
    })
    const reply = await this.request({ cmd: Cmd.Hello }, 5000)
    const capabilities = (reply['capabilities'] ?? {}) as Record<string, unknown>
    this.base64 = capabilities['shouldUseBase64'] !== false
  }

  private stopped(reason: string): void {
    this.helper = null
    this.session = null
    this.buffer = Buffer.alloc(0)
    for (const waiter of this.waiting.splice(0)) waiter.reject(new Error(this.unavailable ?? reason))
  }

  /** A sealed request after pairing; resolves with the opened reply. */
  private async secure(
    cmd: Cmd,
    qid: string,
    host: string,
    body: Record<string, unknown>,
    timeout: number | null,
    replyCmds: number[] = [cmd]
  ): Promise<Record<string, unknown>> {
    const session = this.session
    if (!session?.paired) throw new Error('Apple Passwords isn’t connected.')
    const message = { cmd, tabId: 1, frameId: 0, url: host, payload: JSON.stringify({ QID: qid, SMSG: session.seal(body) }) }
    const reply = await this.request(message, timeout, replyCmds)
    const payload = (typeof reply['payload'] === 'string' ? JSON.parse(reply['payload']) : reply['payload']) as
      { SMSG?: unknown } | undefined
    const opened = session.open(payload?.SMSG)
    const status = Number(opened['STATUS'] ?? 0)
    if (status === 9) this.session = null
    if (status !== 0 && status !== 3) throw new Error(STATUS_MESSAGES[status] ?? 'Apple Passwords couldn’t do that.')
    return opened
  }

  /** Sends one message and waits for the helper's reply to it (one request at a time). */
  private request(message: Record<string, unknown>, timeout: number | null, replyCmds?: number[]): Promise<Record<string, unknown>> {
    const run = (): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        if (!this.helper) return reject(new Error(this.unavailable ?? 'Apple Passwords isn’t running.'))
        const cmds = replyCmds ?? [Number(message['cmd'])]
        let timer: NodeJS.Timeout | null = null
        const waiter = {
          cmds,
          resolve: (reply: Record<string, unknown>) => {
            if (timer) clearTimeout(timer)
            resolve(reply)
          },
          reject: (error: Error) => {
            if (timer) clearTimeout(timer)
            reject(error)
          }
        }
        this.waiting.push(waiter)
        if (timeout !== null) {
          timer = setTimeout(() => {
            const i = this.waiting.indexOf(waiter)
            if (i >= 0) this.waiting.splice(i, 1)
            reject(new Error('Apple Passwords didn’t respond.'))
          }, timeout)
        }
        this.write(message)
      })
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return next
  }

  private write(message: Record<string, unknown>): void {
    const helper = this.helper
    if (!helper || !helper.stdin.writable) return
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(body.length, 0)
    helper.stdin.write(Buffer.concat([header, body]))
  }

  /** Native messaging framing: a 4-byte little-endian length, then JSON. Messages may arrive split or batched. */
  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0)
      if (length > 16 * 1024 * 1024) return this.stopped('Unexpected data from Apple Passwords.')
      if (this.buffer.length < 4 + length) return
      const body = this.buffer.subarray(4, 4 + length)
      this.buffer = this.buffer.subarray(4 + length)
      let message: Record<string, unknown>
      try {
        message = JSON.parse(body.toString('utf8')) as Record<string, unknown>
      } catch {
        continue
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const cmd = Number(message['cmd'])
    // Apple Passwords was turned off, or needs you to sign in again: pair again next time.
    if (cmd === Cmd.PasswordsDisabled || cmd === Cmd.ReloginNeeded) {
      this.session = null
      return
    }
    const i = this.waiting.findIndex((w) => w.cmds.includes(cmd))
    if (i < 0) return
    const [waiter] = this.waiting.splice(i, 1)
    waiter.resolve(message)
  }
}

function helperPath(): string | null {
  for (const manifest of MANIFESTS) {
    try {
      const path = (JSON.parse(readFileSync(manifest, 'utf8')) as { path?: string }).path
      if (path && existsSync(path)) return path
    } catch {
      // Try the next one.
    }
  }
  return existsSync(FALLBACK_HELPER) ? FALLBACK_HELPER : null
}

function hostOf(url: string): string {
  return new URL(url).hostname
}

function readPake(reply: Record<string, unknown>): Record<string, unknown> {
  const payload = (typeof reply['payload'] === 'string' ? JSON.parse(reply['payload']) : reply['payload']) as { PAKE?: string } | undefined
  if (!payload?.PAKE) throw new Error('Unexpected reply from Apple Passwords.')
  return JSON.parse(Buffer.from(payload.PAKE, 'base64').toString('utf8')) as Record<string, unknown>
}

function entries(reply: Record<string, unknown>): Entry[] {
  if (Array.isArray(reply['Entries'])) return reply['Entries'] as Entry[]
  // Older helpers number them instead.
  return Object.keys(reply)
    .filter((key) => /^Entry_\d+$/.test(key))
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
    .map((key) => reply[key] as Entry)
}

/**
 * Passwords kept in memory, for working on the autofill UI without Apple Passwords
 * (development only: ZEPPER_FAKE_PASSWORDS=1). Connecting asks for the code 123456.
 */
export class MemoryPasswords implements PasswordStore {
  readonly confirmsSaves = false
  readonly pairingHint = 'Development passwords (not Apple Passwords): the code is 123456.'
  private connected = false
  private readonly saved: { host: string; username: string; password: string }[] = [
    { host: 'localhost', username: 'octocat@example.com', password: 'hunter2' },
    { host: 'localhost', username: 'work@example.com', password: 'correct horse' }
  ]

  async status(): Promise<StoreStatus> {
    return this.connected ? { state: 'ready' } : { state: 'connect' }
  }

  async logins(url: string): Promise<SavedLogin[]> {
    const host = hostOf(url).replace(/^www\./, '')
    return this.saved.flatMap((l, i) =>
      host === l.host || host.endsWith(`.${l.host}`) ? [{ id: String(i), username: l.username, site: l.host }] : []
    )
  }

  async password(_url: string, id: string): Promise<{ username: string; password: string } | null> {
    const login = this.saved[Number(id)]
    return login ? { username: login.username, password: login.password } : null
  }

  async save(url: string, username: string, password: string): Promise<void> {
    const host = hostOf(url).replace(/^www\./, '')
    const existing = this.saved.find((l) => l.host === host && l.username === username)
    if (existing) existing.password = password
    else this.saved.push({ host, username, password })
  }

  async startPairing(): Promise<void> {}

  async finishPairing(pin: string): Promise<void> {
    if (pin !== '123456') throw new Error('That code didn’t work. Try again.')
    this.connected = true
  }
}
