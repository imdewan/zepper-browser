import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type ECDH
} from 'node:crypto'
import type { PhoneStatus } from '@shared/types'
import { clientData } from './authenticator'
import { decode, encode, type CborValue } from './cbor'
import { credentialsAddon } from './native'
import { WebAuthnError, type PasskeyRequest } from './passkeys'

/**
 * Passkeys from a phone: FIDO's "hybrid" transport (caBLE v2), the QR-code flow Chrome uses. Zepper
 * shows a QR code; the phone scans it and advertises a short encrypted message over Bluetooth (so it
 * must be nearby); both then meet at the phone maker's relay ("tunnel server"), set up an encrypted
 * channel (Noise KNpsk0) and the request goes to the phone as CTAP2. iPhones use their iCloud Keychain
 * passkeys, Android phones Google Password Manager's.
 *
 * Follows Chromium's device/fido/cable (v2_handshake, noise, fido_tunnel_device) and the FIDO
 * Proximity Exchange Protocol.
 */

// ---- QR code and keys ----

/** Relays every phone knows; higher domain ids are hashed names (see decodeDomain). */
const ASSIGNED_DOMAINS = ['cable.ua5v.com', 'cable.auth.com']
/** The FIDO and Google service UUIDs phones advertise under. */
const SERVICES = ['FFF9', 'FDE2']
const enum Derived {
  EidKey = 1,
  TunnelId = 2,
  Psk = 3
}
const DIGIT_WIDTHS = [0, 3, 5, 8, 10, 13, 15, 17]

/** caBLE's QR encoding: 7-byte little-endian chunks as zero-padded decimal, so the QR can be numeric. */
function bytesToDigits(input: Uint8Array): string {
  let digits = ''
  for (let i = 0; i < input.length; i += 7) {
    const chunk = input.subarray(i, Math.min(i + 7, input.length))
    const eight = Buffer.alloc(8)
    eight.set(chunk)
    digits += eight.readBigUInt64LE(0).toString(10).padStart(DIGIT_WIDTHS[chunk.length], '0')
  }
  return digits
}

function derive(length: number, secret: Uint8Array, salt: Uint8Array, type: Derived): Buffer {
  const info = Buffer.alloc(4)
  info.writeUInt32LE(type)
  return Buffer.from(hkdfSync('sha256', secret, salt, info, length))
}

interface Advert {
  plaintext: Buffer
  routingId: Buffer
  domainId: number
}

/** The phone's Bluetooth advert, if it's the one answering this QR code (authenticated, then decrypted). */
function decryptAdvert(advert: Uint8Array, eidKey: Buffer): Advert | null {
  if (advert.length < 20) return null
  const data = Buffer.from(advert.subarray(0, 20))
  const tag = createHmac('sha256', eidKey.subarray(32, 64)).update(data.subarray(0, 16)).digest().subarray(0, 4)
  if (!timingSafeEqual(tag, data.subarray(16, 20))) return null
  const decipher = createDecipheriv('aes-256-ecb', eidKey.subarray(0, 32), null)
  decipher.setAutoPadding(false)
  const plaintext = Buffer.concat([decipher.update(data.subarray(0, 16)), decipher.final()])
  if (plaintext[0] !== 0) return null
  const domainId = plaintext.readUInt16LE(14)
  if (domainId < 256 && domainId >= ASSIGNED_DOMAINS.length) return null
  return { plaintext, routingId: plaintext.subarray(11, 14), domainId }
}

/** The relay a phone chose: one of the assigned ones, or a name derived from its id. */
function decodeDomain(id: number): string {
  if (id < 256) return ASSIGNED_DOMAINS[id]
  const template = Buffer.alloc(31)
  template.write('caBLEv2 tunnel server domain', 0, 'ascii')
  template.writeUInt16LE(id, 28)
  let v = createHash('sha256').update(template).digest().readBigUInt64LE(0)
  const tld = ['com', 'org', 'net', 'info'][Number(v & 3n)]
  v >>= 2n
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let name = 'cable.'
  while (v !== 0n) {
    name += alphabet[Number(v & 31n)]
    v >>= 5n
  }
  return `${name}.${tld}`
}

// ---- Noise KNpsk0 and the encrypted channel ----

const hkdf = (ikm: Uint8Array, salt: Uint8Array, length: number): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.alloc(0), length))

function seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}

function open(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Buffer | null {
  if (ciphertext.length < 16) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(aad)
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
    return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  } catch {
    return null
  }
}

class Noise {
  ck: Buffer<ArrayBufferLike>
  h: Buffer<ArrayBufferLike>
  private k: Buffer<ArrayBufferLike> = Buffer.alloc(32)
  private n = 0

  constructor(name: string) {
    this.ck = Buffer.alloc(32)
    this.ck.write(name, 'ascii')
    this.h = Buffer.from(this.ck)
  }
  mixHash(data: Uint8Array): void {
    this.h = createHash('sha256').update(this.h).update(data).digest()
  }
  mixKey(ikm: Uint8Array): void {
    const out = hkdf(ikm, this.ck, 64)
    this.ck = out.subarray(0, 32)
    this.k = out.subarray(32)
    this.n = 0
  }
  mixKeyAndHash(ikm: Uint8Array): void {
    const out = hkdf(ikm, this.ck, 96)
    this.ck = out.subarray(0, 32)
    this.mixHash(out.subarray(32, 64))
    this.k = out.subarray(64)
    this.n = 0
  }
  private nonce(): Buffer {
    const nonce = Buffer.alloc(12)
    nonce.writeUInt32BE(this.n++, 0)
    return nonce
  }
  encryptAndHash(plaintext: Uint8Array): Buffer {
    const ciphertext = seal(this.k, this.nonce(), plaintext, this.h)
    this.mixHash(ciphertext)
    return ciphertext
  }
  decryptAndHash(ciphertext: Uint8Array): Buffer | null {
    const plaintext = open(this.k, this.nonce(), ciphertext, this.h)
    if (plaintext) this.mixHash(ciphertext)
    return plaintext
  }
  split(): [Buffer, Buffer] {
    const out = hkdf(Buffer.alloc(0), this.ck, 64)
    return [out.subarray(0, 32), out.subarray(32)]
  }
}

/** Messages after the handshake: AES-256-GCM, a counter per direction, padded to 32-byte blocks. */
class Crypter {
  private reads = 0
  private writes = 0

  constructor(
    private readonly readKey: Buffer,
    private readonly writeKey: Buffer
  ) {}

  private static nonce(counter: number): Buffer {
    if (counter > 0xffffff) throw new Error('Too many messages.')
    const nonce = Buffer.alloc(12)
    nonce.writeUInt32BE(counter, 8)
    return nonce
  }
  encrypt(message: Uint8Array): Buffer {
    const padded = Buffer.alloc((message.length + 1 + 31) & ~31)
    padded.set(message)
    padded[padded.length - 1] = padded.length - message.length - 1
    return seal(this.writeKey, Crypter.nonce(this.writes++), padded, Buffer.alloc(0))
  }
  decrypt(ciphertext: Uint8Array): Buffer | null {
    const plaintext = open(this.readKey, Crypter.nonce(this.reads), ciphertext, Buffer.alloc(0))
    if (!plaintext || plaintext.length === 0) return null
    this.reads++
    const padding = plaintext[plaintext.length - 1]
    return padding + 1 > plaintext.length ? null : plaintext.subarray(0, plaintext.length - padding - 1)
  }
}

const PATTERN = 'Noise_KNpsk0_P256_AESGCM_SHA256'

// ---- CTAP ----

const b64 = (value: string): Buffer => Buffer.from(value, 'base64url')
const bytes = (value: CborValue): Buffer => (value instanceof Uint8Array ? Buffer.from(value) : Buffer.alloc(0))
const map = (value: CborValue): Map<CborValue, CborValue> => (value instanceof Map ? value : new Map())
const descriptors = (list: { id: string }[] | undefined): CborValue[] =>
  (list ?? []).map(
    (d) =>
      new Map<CborValue, CborValue>([
        ['id', b64(d.id)],
        ['type', 'public-key']
      ])
  )

const CTAP_ERRORS: Record<number, [string, string]> = {
  0x19: ['InvalidStateError', 'This phone already has a passkey for this account.'],
  0x27: ['NotAllowedError', 'The request was declined on the phone.'],
  0x2e: ['NotAllowedError', 'Your phone has no passkey for this site.']
}

function strictDecode(data: Uint8Array): CborValue | null {
  try {
    const { value, end } = decode(data)
    return end === data.length ? value : null
  } catch {
    return null
  }
}

/**
 * One phone request: show `qr`, then `run()` waits for the phone, talks to it, and resolves with the
 * WebAuthn response (the same shape the other passkey paths produce).
 */
export class HybridSession {
  readonly qr: string
  cancelled = false
  onStatus: (status: Exclude<PhoneStatus, 'scan' | 'error'>) => void = () => {}
  private readonly identity: ECDH
  private readonly secret = randomBytes(16)
  private readonly eidKey: Buffer
  private readonly tunnelId: Buffer
  private socket: WebSocket | null = null
  private abort: ((error: Error) => void) | null = null

  constructor(readonly request: PasskeyRequest) {
    this.identity = createECDH('prime256v1')
    this.identity.generateKeys()
    const qr = new Map<CborValue, CborValue>([
      [0, this.identity.getPublicKey(undefined, 'compressed')],
      [1, this.secret],
      [2, ASSIGNED_DOMAINS.length],
      [3, Math.floor(Date.now() / 1000)],
      // No linking: the phone isn't remembered, so it's the QR code each time (as Chrome does for WebAuthn).
      [4, false],
      [5, request.kind === 'create' ? 'mc' : 'ga']
    ])
    this.qr = `FIDO:/${bytesToDigits(encode(qr))}`
    this.eidKey = derive(64, this.secret, Buffer.alloc(0), Derived.EidKey)
    this.tunnelId = derive(16, this.secret, Buffer.alloc(0), Derived.TunnelId)
  }

  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    credentialsAddon()?.bleStop()
    try {
      this.socket?.close()
    } catch {
      // Already closed.
    }
    this.abort?.(new Error('Cancelled.'))
  }

  async run(): Promise<Record<string, unknown>> {
    try {
      const advert = await this.findPhone()
      this.onStatus('connecting')
      const domain = decodeDomain(advert.domainId)
      const url = `wss://${domain}/cable/connect/${advert.routingId.toString('hex').toUpperCase()}/${this.tunnelId.toString('hex').toUpperCase()}`
      const messages = await this.connect(url, domain)

      // The handshake (KNpsk0): the PSK ties it to this QR code and this advert.
      const psk = derive(32, this.secret, advert.plaintext, Derived.Psk)
      const noise = new Noise(PATTERN)
      noise.mixHash(Buffer.from([1]))
      noise.mixHash(this.identity.getPublicKey(undefined, 'uncompressed'))
      noise.mixKeyAndHash(psk)
      const ephemeral = createECDH('prime256v1')
      ephemeral.generateKeys()
      const ephemeralPub = ephemeral.getPublicKey(undefined, 'uncompressed')
      noise.mixHash(ephemeralPub)
      noise.mixKey(ephemeralPub)
      this.socket!.send(Buffer.concat([ephemeralPub, noise.encryptAndHash(Buffer.alloc(0))]))

      const response = await messages.next()
      if (response.length !== 81) throw new Error('Your phone answered unexpectedly.')
      const peer = response.subarray(0, 65)
      noise.mixHash(peer)
      noise.mixKey(peer)
      noise.mixKey(ephemeral.computeSecret(peer))
      noise.mixKey(this.identity.computeSecret(peer))
      const confirmed = noise.decryptAndHash(response.subarray(65))
      if (!confirmed || confirmed.length !== 0) throw new Error('Couldn’t connect securely to your phone.')
      const [writeKey, readKey] = noise.split()
      const crypter = new Crypter(readKey, writeKey)

      // The phone's first message: its getInfo, and which framing it speaks.
      const first = crypter.decrypt(await messages.next())
      if (!first) throw new Error('Couldn’t read your phone’s reply.')
      let info = strictDecode(first)
      const framed = info !== null
      if (!framed) info = strictDecode(unpad(first))
      const getInfo = map(strictDecode(bytes(map(info).get(1) ?? null)))
      this.onStatus('confirm')

      const data = clientData(this.request.kind === 'create' ? 'webauthn.create' : 'webauthn.get', this.request)
      const hash = createHash('sha256').update(data).digest()
      const [command, body] = this.ctapRequest(hash)
      this.socket!.send(crypter.encrypt(Buffer.concat([framed ? Buffer.from([1, command]) : Buffer.from([command]), encode(body)])))

      let reply: Buffer | null = null
      while (!reply) {
        const frame = crypter.decrypt(await messages.next())
        if (!frame) throw new Error('Couldn’t read your phone’s reply.')
        if (!framed) reply = frame
        else if (frame[0] === 2) continue
        else if (frame[0] === 1) reply = frame.subarray(1)
        else throw new Error('Your phone ended the request.')
      }
      if (framed) this.socket!.send(crypter.encrypt(Buffer.from([0])))
      this.close()

      const status = reply[0]
      if (status !== 0) {
        const [name, message] = CTAP_ERRORS[status] ?? ['NotAllowedError', 'Your phone couldn’t complete the request.']
        throw new WebAuthnError(name, message)
      }
      const result = map(strictDecode(reply.subarray(1)))
      return this.request.kind === 'create' ? this.createResponse(result, data, getInfo) : this.getResponse(result, data)
    } finally {
      credentialsAddon()?.bleStop()
      this.close()
    }
  }

  // ---------------------------------------------------------------------------

  /** Waits for the phone's Bluetooth advert answering this QR code. */
  private findPhone(): Promise<Advert> {
    const addon = credentialsAddon()
    if (!addon) return Promise.reject(new Error('Using a phone needs Zepper’s macOS components (npm run build:credentials).'))
    return new Promise((resolve, reject) => {
      this.abort = reject
      addon.bleScan(JSON.stringify(SERVICES), (json) => {
        if (this.cancelled) return
        const event = JSON.parse(json) as { type: string; data?: string; reason?: string }
        if (event.type === 'advert' && event.data) {
          const advert = decryptAdvert(Buffer.from(event.data, 'base64'), this.eidKey)
          if (advert) {
            addon.bleStop()
            resolve(advert)
          }
        } else if (event.type === 'error') {
          addon.bleStop()
          reject(
            new Error(
              event.reason === 'denied'
                ? 'Zepper isn’t allowed to use Bluetooth. Allow it in System Settings › Privacy & Security › Bluetooth, then try again.'
                : event.reason === 'off'
                  ? 'Turn on Bluetooth on this Mac, then try again.'
                  : 'This Mac’s Bluetooth can’t be used for this.'
            )
          )
        }
      })
    })
  }

  /** Opens the relay connection; `next()` gives each binary message in turn. */
  private connect(url: string, domain: string): Promise<{ next: () => Promise<Buffer> }> {
    return new Promise((resolve, reject) => {
      this.abort = reject
      // Node's WebSocket (undici) takes headers: the relay expects the Origin a browser would send.
      const options = { protocols: ['fido.cable'], headers: { Origin: `wss://${domain}` } }
      const socket = new WebSocket(url, options as unknown as string[])
      socket.binaryType = 'arraybuffer'
      this.socket = socket
      const queue: Buffer[] = []
      const waiting: { resolve: (data: Buffer) => void; reject: (error: Error) => void }[] = []
      let failure: Error | null = null
      const fail = (error: Error): void => {
        failure ??= error
        for (const w of waiting.splice(0)) w.reject(failure)
      }
      socket.addEventListener('message', (event) => {
        if (!(event.data instanceof ArrayBuffer)) return
        const data = Buffer.from(event.data)
        const w = waiting.shift()
        if (w) w.resolve(data)
        else queue.push(data)
      })
      socket.addEventListener('close', () => fail(new Error(this.cancelled ? 'Cancelled.' : 'The connection to your phone closed.')))
      socket.addEventListener('error', () => {
        fail(new Error('Couldn’t reach your phone’s relay.'))
        reject(failure!)
      })
      socket.addEventListener('open', () => {
        if (socket.protocol !== 'fido.cable') {
          socket.close()
          return reject(new Error('The relay didn’t accept the connection.'))
        }
        this.abort = fail
        resolve({
          next: () => {
            const data = queue.shift()
            if (data) return Promise.resolve(data)
            if (failure) return Promise.reject(failure)
            return new Promise((res, rej) => waiting.push({ resolve: res, reject: rej }))
          }
        })
      })
    })
  }

  private close(): void {
    const socket = this.socket
    this.socket = null
    try {
      socket?.close()
    } catch {
      // Already closed.
    }
  }

  /** authenticatorMakeCredential (0x01) or authenticatorGetAssertion (0x02), as Chrome sends them to phones. */
  private ctapRequest(clientDataHash: Buffer): [number, CborValue] {
    const r = this.request
    if (r.kind === 'create') {
      const user = r.user!
      const options = new Map<CborValue, CborValue>([['uv', true]])
      if (r.residentKey === 'required' || r.residentKey === 'preferred') options.set('rk', true)
      const body = new Map<CborValue, CborValue>([
        [1, clientDataHash],
        [
          2,
          new Map<CborValue, CborValue>([
            ['id', r.rpId],
            ['name', r.rpName ?? r.rpId]
          ])
        ],
        // iPhones refuse a user without displayName.
        [
          3,
          new Map<CborValue, CborValue>([
            ['id', b64(user.id)],
            ['name', user.name],
            ['displayName', user.displayName ?? '']
          ])
        ],
        [
          4,
          (r.algorithms ?? [-7]).map(
            (alg) =>
              new Map<CborValue, CborValue>([
                ['alg', alg],
                ['type', 'public-key']
              ])
          )
        ],
        [7, options]
      ])
      if (r.excludeCredentials?.length) body.set(5, descriptors(r.excludeCredentials))
      return [0x01, body]
    }
    const body = new Map<CborValue, CborValue>([
      [1, r.rpId],
      [2, clientDataHash]
    ])
    if (r.allowCredentials?.length) body.set(3, descriptors(r.allowCredentials))
    if (!(r.userVerification === 'discouraged' && r.allowCredentials?.length)) body.set(5, new Map<CborValue, CborValue>([['uv', true]]))
    return [0x02, body]
  }

  private createResponse(result: Map<CborValue, CborValue>, data: Buffer, getInfo: Map<CborValue, CborValue>): Record<string, unknown> {
    const authData = bytes(result.get(2) ?? null)
    if (authData.length < 55) throw new Error('Your phone sent an incomplete passkey.')
    const idLength = authData.readUInt16BE(53)
    const credentialId = authData.subarray(55, 55 + idLength)
    const keepAttestation = this.request.attestation && this.request.attestation !== 'none'
    const attestationObject = encode(
      new Map<CborValue, CborValue>([
        ['fmt', keepAttestation ? (result.get(1) ?? 'none') : 'none'],
        ['attStmt', keepAttestation ? (result.get(3) ?? new Map()) : new Map()],
        ['authData', authData]
      ])
    )
    const transports = Array.isArray(getInfo.get(9)) ? (getInfo.get(9) as string[]) : ['hybrid', 'internal']
    return {
      type: 'create',
      id: credentialId.toString('base64url'),
      clientDataJSON: data.toString('base64url'),
      attestationObject: attestationObject.toString('base64url'),
      attachment: 'cross-platform',
      transports: [...new Set(['hybrid', ...transports])]
    }
  }

  private getResponse(result: Map<CborValue, CborValue>, data: Buffer): Record<string, unknown> {
    // A phone may leave out the credential when the site named exactly one.
    const allowed = this.request.allowCredentials ?? []
    const credentialId = result.has(1)
      ? bytes(map(result.get(1) ?? null).get('id') ?? null)
      : allowed.length === 1
        ? b64(allowed[0].id)
        : null
    if (!credentialId?.length) throw new Error('Your phone didn’t say which passkey it used.')
    const user = map(result.get(4) ?? null).get('id')
    return {
      type: 'get',
      id: credentialId.toString('base64url'),
      clientDataJSON: data.toString('base64url'),
      authenticatorData: bytes(result.get(2) ?? null).toString('base64url'),
      signature: bytes(result.get(3) ?? null).toString('base64url'),
      ...(user instanceof Uint8Array ? { userHandle: Buffer.from(user).toString('base64url') } : {}),
      attachment: 'cross-platform'
    }
  }
}

/** Older phones (protocol revision 0) pad their first message with a length at the end. */
function unpad(data: Buffer): Buffer {
  if (data.length >= 2) {
    const length = data.readUInt16LE(data.length - 2)
    if (length <= data.length - 2) return data.subarray(0, length)
  }
  const length = data[data.length - 1]
  return length < data.length ? data.subarray(0, length) : data
}
