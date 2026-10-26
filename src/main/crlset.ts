import { createHash, X509Certificate } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { Certificate } from 'electron'

/**
 * Chrome's CRLSet: the certificates Google has blocked or revoked (a CA whose keys leaked, one that
 * misissued), which Chrome gets within hours from its component updater. Electron apps don't, so a
 * block would only reach Zepper with an update. Zepper fetches it itself, from the same place, when it
 * starts and every few hours, and refuses what it lists: a block then reaches everyone running it.
 *
 * The format is Chromium's (net/cert/crl_set.cc): a 2-byte little-endian length and a JSON header
 * (BlockedSPKIs: base64 SHA-256 of keys blocked outright), then, for each issuer, the SHA-256 of its
 * key (32 bytes), a 4-byte count, and that many serials of the certificates it revoked (a length byte,
 * then the serial).
 */

const COMPONENT = 'hfnkpimlhhgieaddgfemjhofmfblmnib'
const UPDATE_URL = `https://clients2.google.com/service/update2/crx?x=id%3D${COMPONENT}%26v%3D%26uc&acceptformat=crx3`
const REFRESH_MS = 6 * 60 * 60 * 1000
/** After starting, so it doesn't compete with the first pages. */
const FIRST_FETCH_MS = 20_000
const FILE = 'crlset.bin'

interface Header {
  Sequence: number
  NotAfter?: number
  BlockedSPKIs?: string[] | null
  BlockedInterceptionSPKIs?: string[] | null
}

export interface ParsedCrlSet {
  sequence: number
  /** Keys refused whatever they sign (base64 SHA-256 of the SubjectPublicKeyInfo). */
  blocked: Set<string>
  /** Revoked serials (hex, without leading zeros), by their issuer's key (base64 SHA-256). */
  revoked: Map<string, Set<string>>
}

/** A serial as hex, without the leading zero bytes DER adds (as Chromium compares them). */
export function normalSerial(hex: string): string {
  let serial = hex.toLowerCase().replace(/[^0-9a-f]/g, '')
  if (serial.length % 2) serial = `0${serial}`
  while (serial.length > 2 && serial.startsWith('00')) serial = serial.slice(2)
  return serial
}

export function parseCrlSet(bytes: Uint8Array): ParsedCrlSet {
  const data = Buffer.from(bytes)
  const headerLength = data.readUInt16LE(0)
  const header = JSON.parse(data.subarray(2, 2 + headerLength).toString('utf8')) as Header
  const blocked = new Set([...(header.BlockedSPKIs ?? []), ...(header.BlockedInterceptionSPKIs ?? [])])
  const revoked = new Map<string, Set<string>>()
  let at = 2 + headerLength
  while (at + 36 <= data.length) {
    const issuer = data.subarray(at, at + 32).toString('base64')
    const count = data.readUInt32LE(at + 32)
    at += 36
    const serials = new Set<string>()
    for (let i = 0; i < count && at < data.length; i++) {
      const length = data[at]
      serials.add(normalSerial(data.subarray(at + 1, at + 1 + length).toString('hex')))
      at += 1 + length
    }
    revoked.set(issuer, serials)
  }
  return { sequence: header.Sequence, blocked, revoked }
}

/** A file from a CRX3 package (Chrome's component format): its header, then a ZIP archive. */
export function fileFromCrx(crx: Uint8Array, name: string): Buffer | null {
  const data = Buffer.from(crx)
  if (data.toString('latin1', 0, 4) !== 'Cr24' || data.readUInt32LE(4) !== 3) return null
  return fileFromZip(data.subarray(12 + data.readUInt32LE(8)), name)
}

function fileFromZip(zip: Buffer, name: string): Buffer | null {
  // The end of the central directory: its signature, searched for from the end (past any comment).
  let end = zip.length - 22
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0) return null
  const entries = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  for (let i = 0; i < entries; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) return null
    const method = zip.readUInt16LE(at + 10)
    const size = zip.readUInt32LE(at + 20)
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const commentLength = zip.readUInt16LE(at + 32)
    const offset = zip.readUInt32LE(at + 42)
    if (zip.toString('utf8', at + 46, at + 46 + nameLength) === name) {
      const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28)
      const body = zip.subarray(start, start + size)
      if (method === 0) return Buffer.from(body)
      if (method === 8) return inflateRawSync(body)
      return null
    }
    at += 46 + nameLength + extraLength + commentLength
  }
  return null
}

/** What's needed of a certificate to look it up: its key's hash and its serial. */
interface Identity {
  spki: string
  serial: string
}

const identities = new Map<string, Identity | null>()

function identityOf(cert: Certificate): Identity | null {
  const cached = identities.get(cert.fingerprint)
  if (cached !== undefined) return cached
  let identity: Identity | null = null
  try {
    const x509 = new X509Certificate(cert.data)
    const spki = createHash('sha256')
      .update(x509.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64')
    identity = { spki, serial: normalSerial(x509.serialNumber) }
  } catch {
    // Not one Node can read: Chromium has checked it as it does.
  }
  if (identities.size > 2048) identities.clear()
  identities.set(cert.fingerprint, identity)
  return identity
}

export class CrlSet {
  private current: ParsedCrlSet | null = null
  private timers: NodeJS.Timeout[] = []
  private updatedAt = 0
  private path = ''

  /** The last one fetched (kept in `folder`), then the newest, now and every few hours. */
  async start(folder: string): Promise<void> {
    this.path = join(folder, FILE)
    try {
      const path = this.path
      const [bytes, info] = await Promise.all([readFile(path), stat(path)])
      this.current = parseCrlSet(bytes)
      this.updatedAt = info.mtimeMs
    } catch {
      // None yet.
    }
    this.timers.push(
      setTimeout(() => void this.refresh(), FIRST_FETCH_MS),
      setInterval(() => void this.refresh(), REFRESH_MS)
    )
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }

  /** Which one Zepper has, and when it got it (for About). */
  status(): { sequence: number; updatedAt: number } | null {
    return this.current ? { sequence: this.current.sequence, updatedAt: this.updatedAt } : null
  }

  /** Whether Chrome's CRLSet refuses a chain (leaf first, as Electron gives it). */
  refuses(leaf: Certificate): boolean {
    const crlset = this.current
    if (!crlset) return false
    const seen = new Set<string>()
    for (let cert: Certificate | undefined = leaf; cert && !seen.has(cert.fingerprint); cert = cert.issuerCert) {
      seen.add(cert.fingerprint)
      const identity = identityOf(cert)
      if (!identity) continue
      if (crlset.blocked.has(identity.spki)) return true
      const issuer = cert.issuerCert && cert.issuerCert.fingerprint !== cert.fingerprint ? identityOf(cert.issuerCert) : null
      if (issuer && crlset.revoked.get(issuer.spki)?.has(identity.serial)) return true
    }
    return false
  }

  /** Asks Google's update server for a newer one; checks it's what the server described before using it. */
  async refresh(): Promise<void> {
    try {
      const response = await fetch(UPDATE_URL, { headers: { accept: 'application/xml' } })
      if (!response.ok) return
      const xml = await response.text()
      const check = xml.match(/<updatecheck\b[^>]*>/)?.[0] ?? ''
      const attribute = (name: string): string | undefined => check.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]
      const version = Number(attribute('version'))
      const codebase = attribute('codebase')
      const hash = attribute('hash_sha256')
      if (!codebase || !hash || !version || (this.current && version <= this.current.sequence)) return
      const download = await fetch(codebase.replace(/^http:/, 'https:'))
      if (!download.ok) return
      const crx = Buffer.from(await download.arrayBuffer())
      if (createHash('sha256').update(crx).digest('hex') !== hash.toLowerCase()) return
      const bytes = fileFromCrx(crx, 'crl-set')
      if (!bytes) return
      const parsed = parseCrlSet(bytes)
      if (this.current && parsed.sequence <= this.current.sequence) return
      this.current = parsed
      this.updatedAt = Date.now()
      if (this.path) await writeFile(this.path, bytes)
    } catch (error) {
      console.warn('[crlset] no update', (error as Error).message)
    }
  }
}
