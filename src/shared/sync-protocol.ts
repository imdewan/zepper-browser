/**
 * Zepper Sync, version 1: the format Zepper's apps share, so spaces, Essentials and pinned tabs are
 * the same on every device. This file is the same in the desktop app (src/shared/sync-protocol.ts)
 * and the iPhone app (src/sync/protocol.ts); test vectors in both keep them in step. See docs/SYNC.md.
 *
 * Devices that sync share a 32-byte secret (the sync code, from a QR code or typed). Everything is
 * derived from it, and everything the server keeps is encrypted with it:
 * - the chain id, where the records live (a chain on Zepper's sync server, sync-relay.ts);
 * - the access token, which shows the server a device has the code (it keeps only its hash);
 * - each record's document id, an HMAC of its kind and id (the server can't tell what it is);
 * - the record itself, sealed with XChaCha20-Poly1305 and bound to its document id.
 * The server sees opaque ids, ciphertext and when each document last changed. Nothing else.
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { randomBytes } from '@noble/ciphers/utils.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

export const PROTOCOL_VERSION = 1

export interface SpaceTheme {
  colors: string[]
  opacity: number
  texture: number
  scheme?: 'auto' | 'light' | 'dark'
}

/** A space: its name, emoji and colours (each device keeps its own sign-ins and open tabs for it). */
export interface SpaceRecord {
  type: 'space'
  id: string
  name: string
  icon: string
  theme: SpaceTheme
  /** Fractional index (fractional-indexing), so a move on one device touches only what moved. */
  order: string
}

/** An Essential or a pinned tab. */
export interface PinRecord {
  type: 'pin'
  id: string
  spaceId: string
  zone: 'essential' | 'pinned'
  /** The folder it's in (pinned tabs only). */
  parentId: string | null
  order: string
  url: string
  title: string
}

/** A folder of pinned tabs; folders nest. */
export interface FolderRecord {
  type: 'folder'
  id: string
  spaceId: string
  parentId: string | null
  order: string
  name: string
}

/** A device in the chain, with the tabs it has open (others show them as "on your Mac"). */
export interface DeviceRecord {
  type: 'device'
  id: string
  name: string
  platform: 'ios' | 'mac' | 'linux' | 'windows'
  /** When it last checked in (ms since 1970). */
  seenAt: number
  tabs: { url: string; title: string; spaceId: string | null }[]
}

/** A tab sent to another device, which opens it and deletes this. */
export interface SendRecord {
  type: 'send'
  id: string
  to: string
  from: string
  url: string
  title: string
  at: number
}

export type SyncRecord = SpaceRecord | PinRecord | FolderRecord | DeviceRecord | SendRecord
export type RecordType = SyncRecord['type']

/** A document on the server: the sealed record, or null once it's been deleted (kept a while so others hear of it). */
export interface StoredRecord {
  v: number
  c: string | null
}

export interface ChainKeys {
  chainId: string
  /** Shown to the server, which lets only devices with it into the chain. */
  access: string
  encrypt: Uint8Array
  name: Uint8Array
}

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder()
const SALT = utf8.encode('zepper-sync-v1')

/** Everything a device needs, from the shared secret. */
export function deriveKeys(secret: Uint8Array): ChainKeys {
  if (secret.length !== 32) throw new Error('A sync secret is 32 bytes')
  return {
    chainId: base64url(hkdf(sha256, secret, SALT, utf8.encode('chain'), 16)),
    access: base64url(hkdf(sha256, secret, SALT, utf8.encode('access'), 32)),
    encrypt: hkdf(sha256, secret, SALT, utf8.encode('encrypt'), 32),
    name: hkdf(sha256, secret, SALT, utf8.encode('name'), 32)
  }
}

export function newSecret(): Uint8Array {
  return randomBytes(32)
}

/** A record's document id: the same on every device, meaningless to the server. */
export function documentId(keys: ChainKeys, type: RecordType, id: string): string {
  return base64url(hmac(sha256, keys.name, utf8.encode(`${type}/${id}`)).slice(0, 16))
}

/** The record, encrypted for its document (nonce, then ciphertext and tag). */
export function seal(keys: ChainKeys, docId: string, record: SyncRecord, nonce: Uint8Array = randomBytes(24)): string {
  const sealed = xchacha20poly1305(keys.encrypt, nonce, utf8.encode(docId)).encrypt(utf8.encode(JSON.stringify(record)))
  const out = new Uint8Array(nonce.length + sealed.length)
  out.set(nonce)
  out.set(sealed, nonce.length)
  return base64url(out)
}

/** The record in a document, or null if it can't be read (another chain's, tampered with, or from a newer Zepper). */
export function open(keys: ChainKeys, docId: string, sealed: string): SyncRecord | null {
  try {
    const bytes = fromBase64url(sealed)
    if (bytes.length < 24 + 16) return null
    const plain = xchacha20poly1305(keys.encrypt, bytes.subarray(0, 24), utf8.encode(docId)).decrypt(bytes.subarray(24))
    const record = JSON.parse(fromUtf8.decode(plain)) as SyncRecord
    if (!isRecord(record)) return null
    // Sealed for another document: not what it claims to be.
    return documentId(keys, record.type, record.id) === docId ? record : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is SyncRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return false
  switch (r.type) {
    case 'space':
      return (
        typeof r.name === 'string' && typeof r.icon === 'string' && typeof r.order === 'string' && !!r.theme && typeof r.theme === 'object'
      )
    case 'pin':
      return (
        typeof r.spaceId === 'string' &&
        (r.zone === 'essential' || r.zone === 'pinned') &&
        typeof r.url === 'string' &&
        typeof r.order === 'string'
      )
    case 'folder':
      return typeof r.spaceId === 'string' && typeof r.name === 'string' && typeof r.order === 'string'
    case 'device':
      return typeof r.name === 'string' && Array.isArray(r.tabs)
    case 'send':
      return typeof r.to === 'string' && typeof r.url === 'string'
    default:
      return false
  }
}

// ---- The sync code ------------------------------------------------------------------------------
//
// The secret as 52 characters of Crockford base32 in groups of four (easy to read out and type:
// no I, L, O or U, and either case), or as a link for a QR code: zepper://sync#CODE.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function encodeCode(secret: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of secret) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out.match(/.{1,4}/g)!.join('-')
}

/** The secret in a typed or scanned code (or a zepper://sync link), or null if it isn't one. */
export function decodeCode(input: string): Uint8Array | null {
  const text = input.trim().replace(/^zepper:\/\/sync[#?/]*(code=)?/i, '')
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
  if (clean.length !== 52) return null
  const out = new Uint8Array(32)
  let bits = 0
  let value = 0
  let i = 0
  for (const char of clean) {
    const n = ALPHABET.indexOf(char)
    if (n === -1) return null
    value = ((value << 5) | n) & 0xffff
    bits += 5
    if (bits >= 8) {
      if (i < 32) out[i++] = (value >>> (bits - 8)) & 255
      bits -= 8
    }
  }
  return i === 32 ? out : null
}

export function codeLink(secret: Uint8Array): string {
  return `zepper://sync#${encodeCode(secret).replace(/-/g, '')}`
}

// ---- base64url ----------------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function base64url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63]
    if (i + 1 < bytes.length) out += B64[(n >>> 6) & 63]
    if (i + 2 < bytes.length) out += B64[n & 63]
  }
  return out
}

export function fromBase64url(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let bits = 0
  let value = 0
  let i = 0
  for (const char of text) {
    const n = B64.indexOf(char)
    if (n === -1) throw new Error('Not base64url')
    value = ((value << 6) | n) & 0xffffff
    bits += 6
    if (bits >= 8) {
      out[i++] = (value >>> (bits - 8)) & 255
      bits -= 8
    }
  }
  return out.subarray(0, i)
}
