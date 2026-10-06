import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import type { PasskeyRecord, Vault } from './vault'

/**
 * Zepper's own passkey authenticator, the way password managers like 1Password and Bitwarden
 * provide one: P-256 keys made and kept in Zepper's vault on this Mac, with Touch ID (checked by
 * the caller) as user verification. It produces exactly what a platform authenticator would:
 * client data, authenticator data, a "none" attestation and ES256 signatures.
 */

/** Identifies passkeys made by Zepper to the sites that look (the AAGUID). */
const AAGUID = Buffer.from('e3b461281524465fa0d032d94393e697', 'hex')

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40

export interface CeremonyBase {
  origin: string
  rpId: string
  /** base64url */
  challenge: string
  /** Whether you were verified (Touch ID or your password). */
  verified: boolean
}

const b64url = (data: Buffer): string => data.toString('base64url')
const sha256 = (data: Buffer | string): Buffer => createHash('sha256').update(data).digest()

/** The client data the signature covers, as Chrome writes it (key order matters to some sites). */
function clientData(type: 'webauthn.create' | 'webauthn.get', ceremony: CeremonyBase): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge: ceremony.challenge, origin: ceremony.origin, crossOrigin: false }), 'utf8')
}

function authenticatorData(rpId: string, flags: number, attested?: Buffer): Buffer {
  // The signature counter stays 0, as for passkeys on other platforms.
  return Buffer.concat([sha256(rpId), Buffer.from([flags, 0, 0, 0, 0]), attested ?? Buffer.alloc(0)])
}

// ---- CBOR (just what attestation objects and COSE keys need) ----

type Cbor = number | string | Buffer | Map<number | string, Cbor>

function cbor(value: Cbor): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n])
    if (n < 0x100) return Buffer.from([(major << 5) | 24, n])
    if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff])
    const b = Buffer.alloc(5)
    b[0] = (major << 5) | 26
    b.writeUInt32BE(n, 1)
    return b
  }
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8')
    return Buffer.concat([head(3, text.length), text])
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value])
  const parts = [head(5, value.size)]
  for (const [k, v] of value) parts.push(cbor(k), cbor(v))
  return Buffer.concat(parts)
}

export interface CreateResult {
  record: PasskeyRecord
  /** What the page gets (same shape as the system path's results). */
  response: Record<string, unknown>
}

/** Makes a new passkey for a site. The caller saves it once the page has the result. */
export function makeCredential(ceremony: CeremonyBase & { user: { id: string; name: string; displayName: string } }): CreateResult {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const coseKey = cbor(
    new Map<number, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')]
    ])
  )
  const credentialId = randomBytes(32)
  const idLength = Buffer.from([credentialId.length >> 8, credentialId.length & 0xff])
  const authData = authenticatorData(
    ceremony.rpId,
    FLAG_UP | FLAG_AT | (ceremony.verified ? FLAG_UV : 0),
    Buffer.concat([AAGUID, idLength, credentialId, coseKey])
  )
  const attestationObject = cbor(
    new Map<string, Cbor>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData]
    ])
  )
  const now = Date.now()
  const record: PasskeyRecord = {
    id: b64url(credentialId),
    rpId: ceremony.rpId,
    userHandle: ceremony.user.id,
    userName: ceremony.user.name,
    displayName: ceremony.user.displayName,
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    alg: -7,
    created: now,
    lastUsed: now
  }
  return {
    record,
    response: {
      type: 'create',
      id: record.id,
      clientDataJSON: b64url(clientData('webauthn.create', ceremony)),
      attestationObject: b64url(attestationObject),
      attachment: 'platform',
      transports: ['internal']
    }
  }
}

/** Signs in with a saved passkey. */
export function getAssertion(vault: Vault, passkey: PasskeyRecord, ceremony: CeremonyBase): Record<string, unknown> {
  const data = clientData('webauthn.get', ceremony)
  const authData = authenticatorData(ceremony.rpId, FLAG_UP | (ceremony.verified ? FLAG_UV : 0))
  const key = createPrivateKey({ key: Buffer.from(passkey.privateKey, 'base64'), format: 'der', type: 'pkcs8' })
  // ECDSA over authenticatorData ‖ SHA-256(clientDataJSON), DER-encoded as WebAuthn expects.
  const signature = sign('sha256', Buffer.concat([authData, sha256(data)]), key)
  vault.usedPasskey(passkey.id)
  return {
    type: 'get',
    id: passkey.id,
    clientDataJSON: b64url(data),
    authenticatorData: b64url(authData),
    signature: b64url(signature),
    userHandle: passkey.userHandle,
    attachment: 'platform'
  }
}
