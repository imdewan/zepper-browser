import type { BrowserWindow, WebFrameMain } from 'electron'
import { parse as parseDomain } from 'tldts-experimental'
import { credentialsAddon } from './native'

/**
 * Pages' passkey requests (navigator.credentials.create() and get()): checked here, in the main
 * process, then served by Zepper's own authenticator (authenticator.ts) or, when Zepper is signed
 * with Apple's browser entitlement, by macOS (iCloud Keychain, a phone nearby, security keys)
 * through the credentials addon. The origin always comes from the frame itself, and the relying
 * party must be that origin's own site.
 */

/** A WebAuthn failure, named like the DOMException the page should see. */
export class WebAuthnError extends Error {
  constructor(
    readonly domName: string,
    message: string
  ) {
    super(message)
  }
}

export type Verification = 'required' | 'preferred' | 'discouraged'

export interface Descriptor {
  id: string
  transports?: string[]
}

/** A checked request. Binary values stay base64url. */
export interface PasskeyRequest {
  kind: 'create' | 'get'
  origin: string
  rpId: string
  challenge: string
  userVerification: Verification
  conditional: boolean
  // create()
  rpName?: string
  user?: { id: string; name: string; displayName: string }
  algorithms?: number[]
  excludeCredentials?: Descriptor[]
  residentKey?: string
  attestation?: string
  attachment?: string
  // get()
  allowCredentials?: Descriptor[]
  appid?: string
}

type Json = Record<string, unknown>

const SECURE_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const verification = (value: unknown): Verification => (value === 'required' || value === 'discouraged' ? value : 'preferred')
const descriptors = (value: unknown): Descriptor[] =>
  Array.isArray(value)
    ? (value as Json[]).flatMap((d) =>
        str(d?.['id'])
          ? [{ id: d['id'] as string, transports: Array.isArray(d['transports']) ? (d['transports'] as string[]) : undefined }]
          : []
      )
    : []

/** The relying party a page may use: its own host or a parent domain of it (never a public suffix). */
function validRpId(rpId: string, host: string): boolean {
  if (rpId === host) return true
  if (!host.endsWith(`.${rpId}`)) return false
  const parsed = parseDomain(rpId)
  return !parsed.isIp && Boolean(parsed.domain) && parsed.publicSuffix !== rpId
}

/** Checks a page's request against the frame it came from. `options` is WebAuthn's JSON form. */
export function checkRequest(frame: WebFrameMain, kind: 'create' | 'get', options: Json): PasskeyRequest {
  let url: URL
  try {
    url = new URL(frame.url)
  } catch {
    throw new WebAuthnError('SecurityError', 'This page can’t use passkeys.')
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && SECURE_LOCAL.test(url.hostname))
  if (!secure || frame.parent) throw new WebAuthnError('SecurityError', 'This page can’t use passkeys.')
  const host = url.hostname
  const rp = (options['rp'] ?? {}) as Json
  const rpId = (kind === 'create' ? str(rp['id']) : str(options['rpId'])) ?? host
  if (!validRpId(rpId, host)) {
    throw new WebAuthnError('SecurityError', 'The relying party ID is not a registrable domain suffix of, nor equal to the current domain.')
  }
  const challenge = str(options['challenge'])
  if (!challenge) throw new WebAuthnError('TypeError', 'Missing challenge.')
  const request: PasskeyRequest = {
    kind,
    origin: url.origin,
    rpId,
    challenge,
    userVerification: 'preferred',
    conditional: kind === 'get' && options['mediation'] === 'conditional'
  }
  if (kind === 'create') {
    const user = (options['user'] ?? {}) as Json
    if (!str(user['id'])) throw new WebAuthnError('TypeError', 'Missing user ID.')
    const selection = (options['authenticatorSelection'] ?? {}) as Json
    const params = Array.isArray(options['pubKeyCredParams']) ? (options['pubKeyCredParams'] as Json[]) : []
    Object.assign(request, {
      rpName: str(rp['name']) ?? rpId,
      user: { id: user['id'] as string, name: str(user['name']) ?? '', displayName: str(user['displayName']) ?? '' },
      // An empty list means the defaults: ES256 and RS256.
      algorithms: params.length ? params.filter((p) => p['type'] === 'public-key').map((p) => Number(p['alg'])) : [-7, -257],
      excludeCredentials: descriptors(options['excludeCredentials']),
      userVerification: verification(selection['userVerification']),
      residentKey: str(selection['residentKey']) ?? (selection['requireResidentKey'] ? 'required' : 'discouraged'),
      attestation: str(options['attestation']) ?? 'none',
      attachment: str(selection['authenticatorAttachment'])
    })
  } else {
    const extensions = (options['extensions'] ?? {}) as Json
    const appid = str(extensions['appid'])
    let appidOk = false
    if (appid) {
      try {
        const appHost = new URL(appid).hostname
        appidOk = (parseDomain(appHost).domain ?? appHost) === (parseDomain(host).domain ?? host)
      } catch {
        appidOk = false
      }
    }
    Object.assign(request, {
      allowCredentials: descriptors(options['allowCredentials']),
      userVerification: verification(options['userVerification']),
      appid: appidOk ? appid : undefined
    })
  }
  return request
}

/** Whether macOS's own passkeys can be used (built with the addon and signed with Apple's browser entitlement). */
export function systemPasskeysAvailable(): boolean {
  try {
    return credentialsAddon()?.available() ?? false
  } catch {
    return false
  }
}

let busy = false

/** Runs a request through macOS: iCloud Keychain passkeys, a phone nearby, or a security key. */
export async function systemPasskey(win: BrowserWindow, request: PasskeyRequest): Promise<Json> {
  const addon = credentialsAddon()
  if (!addon || !addon.available()) throw new WebAuthnError('NotSupportedError', 'Passkeys from other devices aren’t available.')
  if (busy) throw new WebAuthnError('NotAllowedError', 'A request is already pending.')
  const native: Json = {
    kind: request.kind,
    origin: request.origin,
    rpId: request.rpId,
    challenge: request.challenge,
    userVerification: request.userVerification,
    platform: true,
    securityKey: request.attachment !== 'platform',
    hybrid: request.attachment !== 'platform',
    user: request.user,
    algorithms: request.algorithms,
    excludeCredentials: request.excludeCredentials,
    residentKey: request.residentKey,
    attestation: request.attestation,
    allowCredentials: request.allowCredentials,
    appid: request.appid
  }
  busy = true
  try {
    return JSON.parse(await addon.perform(win.getNativeWindowHandle(), JSON.stringify(native))) as Json
  } catch (error) {
    if (typeof error === 'string') {
      const parsed = JSON.parse(error) as { name?: string; message?: string }
      throw new WebAuthnError(parsed.name ?? 'NotAllowedError', parsed.message ?? 'The operation either timed out or was not allowed.')
    }
    throw error
  } finally {
    busy = false
  }
}

export function cancelSystemPasskey(): void {
  credentialsAddon()?.cancel()
}
