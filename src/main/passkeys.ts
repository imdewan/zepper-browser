import type { BrowserWindow, WebFrameMain } from 'electron'
import { parse as parseDomain } from 'tldts-experimental'
import { credentialsAddon } from './native'

/**
 * Passkeys and security keys through macOS (native/credentials): pages' navigator.credentials calls
 * reach the system's own sheets, so passkeys saved in Apple Passwords, a phone nearby and USB
 * security keys all work, and new passkeys sync through iCloud Keychain. The checks a browser owes
 * the page's users happen here, in the main process: the origin comes from the frame itself, and
 * the relying party must be that origin's own site.
 */

/** Whether Zepper can use the system's passkeys (built with the addon and signed with Apple's browser entitlement). */
export function passkeysAvailable(): boolean {
  try {
    return credentialsAddon()?.available() ?? false
  } catch {
    return false
  }
}

/** A WebAuthn failure, named like the DOMException the page should see. */
export class WebAuthnError extends Error {
  constructor(
    readonly domName: string,
    message: string
  ) {
    super(message)
  }
}

type Json = Record<string, unknown>

const SECURE_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/

/** The relying party a page may use: its own host or a parent domain of it (never a public suffix). */
function validRpId(rpId: string, host: string): boolean {
  if (rpId === host) return true
  if (!host.endsWith(`.${rpId}`)) return false
  const parsed = parseDomain(rpId)
  return !parsed.isIp && Boolean(parsed.domain) && parsed.publicSuffix !== rpId
}

let busy = false

/**
 * Runs a page's navigator.credentials.create() or get() through macOS. `options` is the page's
 * publicKey options in WebAuthn's JSON form (binary as base64url).
 */
export async function performWebAuthn(win: BrowserWindow, frame: WebFrameMain, kind: 'create' | 'get', options: Json): Promise<Json> {
  const addon = credentialsAddon()
  if (!addon || !addon.available()) throw new WebAuthnError('NotSupportedError', 'Passkeys aren’t available.')
  let url: URL
  try {
    url = new URL(frame.url)
  } catch {
    throw new WebAuthnError('SecurityError', 'This page can’t use passkeys.')
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && SECURE_LOCAL.test(url.hostname))
  if (!secure || frame.parent) throw new WebAuthnError('SecurityError', 'This page can’t use passkeys.')
  const host = url.hostname
  const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

  const rp = (options['rp'] ?? {}) as Json
  const rpId = (kind === 'create' ? str(rp['id']) : str(options['rpId'])) ?? host
  if (!validRpId(rpId, host))
    throw new WebAuthnError('SecurityError', 'The relying party ID is not a registrable domain suffix of, nor equal to the current domain.')
  if (!str(options['challenge'])) throw new WebAuthnError('TypeError', 'Missing challenge.')

  const request: Json = {
    kind,
    origin: url.origin,
    rpId,
    challenge: options['challenge'],
    userVerification: 'preferred',
    platform: true,
    securityKey: true,
    hybrid: true
  }

  if (kind === 'create') {
    const user = (options['user'] ?? {}) as Json
    if (!str(user['id'])) throw new WebAuthnError('TypeError', 'Missing user ID.')
    const selection = (options['authenticatorSelection'] ?? {}) as Json
    const params = Array.isArray(options['pubKeyCredParams']) ? (options['pubKeyCredParams'] as Json[]) : []
    // An empty list means the defaults: ES256 and RS256.
    const algorithms = params.length ? params.filter((p) => p['type'] === 'public-key').map((p) => Number(p['alg'])) : [-7, -257]
    const attachment = str(selection['authenticatorAttachment'])
    Object.assign(request, {
      user: { id: user['id'], name: str(user['name']) ?? '', displayName: str(user['displayName']) ?? '' },
      algorithms,
      excludeCredentials: options['excludeCredentials'] ?? [],
      userVerification: str(selection['userVerification']) ?? 'preferred',
      residentKey: str(selection['residentKey']) ?? (selection['requireResidentKey'] ? 'required' : 'discouraged'),
      attestation: str(options['attestation']) ?? 'none',
      // The system's passkey sheet also offers a phone nearby, so it stays for cross-platform requests.
      platform: true,
      securityKey: attachment !== 'platform',
      hybrid: attachment !== 'platform'
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
      allowCredentials: options['allowCredentials'] ?? [],
      userVerification: str(options['userVerification']) ?? 'preferred',
      appid: appidOk ? appid : undefined
    })
  }

  if (busy) throw new WebAuthnError('NotAllowedError', 'A request is already pending.')
  busy = true
  try {
    const result = JSON.parse(await addon.perform(win.getNativeWindowHandle(), JSON.stringify(request))) as Json
    return result
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

/** The page gave up on its request (its AbortSignal fired). */
export function cancelWebAuthn(): void {
  credentialsAddon()?.cancel()
}
