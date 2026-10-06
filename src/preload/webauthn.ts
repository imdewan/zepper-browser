/**
 * Passkeys: navigator.credentials.create() and get() for public-key credentials go to Zepper's
 * password manager, which keeps passkeys on this Mac (and, in builds signed with Apple's browser
 * entitlement, can also hand a request to macOS for iCloud Keychain, a phone or a security key).
 * Runs in the page's own world, so it must stay self-contained: contextBridge sends this
 * function's source text, not its closure. `invoke` and `cancel` are bridged in from the preload.
 *
 * The page gets genuine-looking credential objects (PublicKeyCredential with an attestation or
 * assertion response), so WebAuthn libraries treat them like Chrome's own.
 */
export function webauthnShim(invoke: (kind: string, options: string) => Promise<string>, cancel: () => void): void {
  type Bytes = ArrayBuffer | ArrayBufferView
  type Dict = Record<string, unknown>
  const w = window as unknown as Dict & {
    PublicKeyCredential?: { prototype: object } & Dict
    AuthenticatorAttestationResponse?: { prototype: object }
    AuthenticatorAssertionResponse?: { prototype: object }
  }
  const container = (w['CredentialsContainer'] as { prototype: Dict } | undefined)?.prototype
  const PKC = w.PublicKeyCredential
  if (!container || !PKC || !w.AuthenticatorAttestationResponse || !w.AuthenticatorAssertionResponse) return
  const attestationProto = w.AuthenticatorAttestationResponse.prototype
  const assertionProto = w.AuthenticatorAssertionResponse.prototype
  const originalCreate = container['create'] as (this: unknown, options?: unknown) => Promise<unknown>
  const originalGet = container['get'] as (this: unknown, options?: unknown) => Promise<unknown>

  const isBytes = (value: unknown): value is Bytes => value instanceof ArrayBuffer || ArrayBuffer.isView(value)
  const view = (value: Bytes): Uint8Array =>
    value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  const toB64 = (value: Bytes): string => {
    const bytes = view(value)
    let text = ''
    for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i])
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const fromB64 = (text: string): ArrayBuffer => {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out.buffer
  }
  const hex = (text: string): number[] => (text.match(/../g) ?? []).map((h) => parseInt(h, 16))
  const typeError = (message: string): Promise<never> => Promise.reject(new TypeError(message))

  const descriptors = (list: unknown): Dict[] =>
    Array.isArray(list)
      ? list
          .filter((d) => d && isBytes((d as Dict)['id']))
          .map((d) => ({
            type: 'public-key',
            id: toB64((d as Dict)['id'] as Bytes),
            transports: Array.isArray((d as Dict)['transports']) ? ((d as Dict)['transports'] as unknown[]).map(String) : undefined
          }))
      : []

  // ---- CBOR (just enough for attestation objects and COSE keys) ----
  const cbor = (bytes: Uint8Array, start = 0): { value: unknown; end: number } => {
    let pos = start
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const length = (info: number): number => {
      if (info < 24) return info
      if (info === 24) return bytes[pos++]
      if (info === 25) return ((pos += 2), data.getUint16(pos - 2))
      if (info === 26) return ((pos += 4), data.getUint32(pos - 4))
      if (info === 27) return ((pos += 8), Number(data.getBigUint64(pos - 8)))
      throw new Error('cbor')
    }
    const item = (): unknown => {
      const head = bytes[pos++]
      const major = head >> 5
      const n = length(head & 31)
      switch (major) {
        case 0:
          return n
        case 1:
          return -1 - n
        case 2: {
          const value = bytes.slice(pos, pos + n)
          pos += n
          return value
        }
        case 3: {
          const value = new TextDecoder().decode(bytes.subarray(pos, pos + n))
          pos += n
          return value
        }
        case 4:
          return Array.from({ length: n }, () => item())
        case 5: {
          const map = new Map<unknown, unknown>()
          for (let i = 0; i < n; i++) {
            const key = item()
            map.set(key, item())
          }
          return map
        }
        case 6:
          return item()
        default:
          return n === 21 ? true : n === 20 ? false : null
      }
    }
    return { value: item(), end: pos }
  }

  // ---- DER, for the public key in SubjectPublicKeyInfo form ----
  const derLength = (n: number): number[] => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255])
  const der = (tag: number, body: number[]): number[] => [tag, ...derLength(body.length), ...body]
  const derInteger = (bytes: Uint8Array): number[] => {
    let i = 0
    while (i < bytes.length - 1 && bytes[i] === 0) i++
    const body = Array.from(bytes.subarray(i))
    return der(0x02, body[0] & 0x80 ? [0, ...body] : body)
  }

  /** The new credential's public key and algorithm, from the attestation object. */
  const attestedKey = (attestationObject: ArrayBuffer): { authData: ArrayBuffer; spki: ArrayBuffer | null; alg: number } => {
    const object = cbor(new Uint8Array(attestationObject)).value as Map<string, unknown>
    const authData = object.get('authData') as Uint8Array
    let spki: ArrayBuffer | null = null
    let alg = -7
    if (authData && authData[32] & 0x40) {
      const idLength = (authData[53] << 8) | authData[54]
      const key = cbor(authData, 55 + idLength).value as Map<number, unknown>
      alg = Number(key.get(3))
      const kty = Number(key.get(1))
      const x = key.get(-2) as Uint8Array
      const y = key.get(-3) as Uint8Array
      let bytes: number[] | null = null
      if (kty === 2 && Number(key.get(-1)) === 1 && x && y) {
        bytes = [...hex('3059301306072a8648ce3d020106082a8648ce3d030107034200'), 4, ...x, ...y]
      } else if (kty === 1 && Number(key.get(-1)) === 6 && x) {
        bytes = [...hex('302a300506032b6570032100'), ...x]
      } else if (kty === 3) {
        const n = key.get(-1) as Uint8Array
        const e = key.get(-2) as Uint8Array
        const rsaKey = der(0x30, [...derInteger(n), ...derInteger(e)])
        bytes = der(0x30, [...hex('300d06092a864886f70d0101010500'), ...der(0x03, [0, ...rsaKey])])
      }
      if (bytes) spki = new Uint8Array(bytes).buffer
    }
    return { authData: authData ? authData.slice().buffer : new ArrayBuffer(0), spki, alg }
  }

  const define = (target: object, values: Dict): void => {
    for (const [key, value] of Object.entries(values)) Object.defineProperty(target, key, { value, enumerable: true, configurable: true })
  }

  const credential = (kind: string, r: Dict, extensions: Dict): object => {
    const id = String(r['id'])
    const clientDataJSON = fromB64(String(r['clientDataJSON']))
    let response: object
    let responseJson: Dict
    if (kind === 'create') {
      const attestationObject = fromB64(String(r['attestationObject']))
      const { authData, spki, alg } = attestedKey(attestationObject)
      const transports = (r['transports'] as string[]) ?? []
      response = Object.create(attestationProto) as object
      define(response, { clientDataJSON, attestationObject })
      Object.defineProperties(response, {
        getAuthenticatorData: { value: () => authData.slice(0), configurable: true },
        getPublicKey: { value: () => (spki ? spki.slice(0) : null), configurable: true },
        getPublicKeyAlgorithm: { value: () => alg, configurable: true },
        getTransports: { value: () => transports.slice(), configurable: true }
      })
      responseJson = {
        clientDataJSON: r['clientDataJSON'],
        attestationObject: r['attestationObject'],
        authenticatorData: toB64(authData),
        transports,
        publicKeyAlgorithm: alg,
        ...(spki ? { publicKey: toB64(spki) } : {})
      }
    } else {
      const userHandle = typeof r['userHandle'] === 'string' ? fromB64(r['userHandle']) : null
      response = Object.create(assertionProto) as object
      define(response, {
        clientDataJSON,
        authenticatorData: fromB64(String(r['authenticatorData'])),
        signature: fromB64(String(r['signature'])),
        userHandle
      })
      responseJson = {
        clientDataJSON: r['clientDataJSON'],
        authenticatorData: r['authenticatorData'],
        signature: r['signature'],
        ...(typeof r['userHandle'] === 'string' ? { userHandle: r['userHandle'] } : {})
      }
    }
    const results: Dict = {}
    if (kind === 'create' && extensions['credProps'])
      results['credProps'] = { rk: r['attachment'] === 'platform' || extensions['residentKey'] === 'required' }
    if (kind === 'get' && extensions['appid']) results['appid'] = Boolean(r['appid'])
    const out = Object.create(PKC.prototype) as object
    define(out, { id, rawId: fromB64(id), type: 'public-key', authenticatorAttachment: r['attachment'] ?? null, response })
    Object.defineProperties(out, {
      getClientExtensionResults: { value: () => ({ ...results }), configurable: true },
      toJSON: {
        value: () => ({
          id,
          rawId: id,
          type: 'public-key',
          authenticatorAttachment: r['attachment'] ?? null,
          response: responseJson,
          clientExtensionResults: { ...results }
        }),
        configurable: true
      }
    })
    return out
  }

  const run = (kind: 'create' | 'get', options: Dict): Promise<unknown> => {
    const pk = options['publicKey'] as Dict
    const signal = options['signal'] as AbortSignal | undefined
    const aborted = (): unknown => signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
    if (signal?.aborted) return Promise.reject(aborted())
    if (!isBytes(pk['challenge']))
      return typeError(`Failed to execute '${kind}' on 'CredentialsContainer': required member challenge is undefined.`)
    let json: Dict
    const extensions = (pk['extensions'] ?? {}) as Dict
    if (kind === 'create') {
      const rp = pk['rp'] as Dict | undefined
      const user = pk['user'] as Dict | undefined
      if (!rp || !user || !isBytes(user['id']))
        return typeError("Failed to execute 'create' on 'CredentialsContainer': required member user is undefined.")
      const selection = pk['authenticatorSelection'] as Dict | undefined
      json = {
        rp: { id: rp['id'], name: rp['name'] },
        user: { id: toB64(user['id'] as Bytes), name: user['name'], displayName: user['displayName'] },
        challenge: toB64(pk['challenge'] as Bytes),
        pubKeyCredParams: Array.isArray(pk['pubKeyCredParams'])
          ? (pk['pubKeyCredParams'] as Dict[]).map((p) => ({ type: p['type'], alg: p['alg'] }))
          : [],
        excludeCredentials: descriptors(pk['excludeCredentials']),
        authenticatorSelection: selection
          ? {
              authenticatorAttachment: selection['authenticatorAttachment'],
              residentKey: selection['residentKey'],
              requireResidentKey: selection['requireResidentKey'],
              userVerification: selection['userVerification']
            }
          : undefined,
        attestation: pk['attestation']
      }
    } else {
      json = {
        challenge: toB64(pk['challenge'] as Bytes),
        mediation: options['mediation'],
        rpId: pk['rpId'],
        allowCredentials: descriptors(pk['allowCredentials']),
        userVerification: pk['userVerification'],
        extensions: typeof extensions['appid'] === 'string' ? { appid: extensions['appid'] } : undefined
      }
    }
    const residentKey = ((pk['authenticatorSelection'] ?? {}) as Dict)['residentKey']
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        cancel()
        reject(aborted())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      invoke(kind, JSON.stringify(json)).then(
        (text) => {
          signal?.removeEventListener('abort', onAbort)
          if (signal?.aborted) return
          const reply = JSON.parse(text) as { ok: boolean; result?: Dict; name?: string; message?: string }
          if (!reply.ok || !reply.result) {
            const message = reply.message ?? 'The operation either timed out or was not allowed.'
            return reject(reply.name === 'TypeError' ? new TypeError(message) : new DOMException(message, reply.name ?? 'NotAllowedError'))
          }
          resolve(credential(kind, reply.result, { ...extensions, residentKey }))
        },
        () => {
          signal?.removeEventListener('abort', onAbort)
          reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'))
        }
      )
    })
  }

  const methods = {
    create(this: unknown, options?: unknown): Promise<unknown> {
      const o = options as Dict | undefined
      if (o && typeof o === 'object' && o['publicKey']) return run('create', o)
      return originalCreate.call(this, options)
    },
    get(this: unknown, options?: unknown): Promise<unknown> {
      const o = options as Dict | undefined
      // Conditional requests (passkey autofill) wait until you pick a passkey under the username field.
      if (o && typeof o === 'object' && o['publicKey']) return run('get', o)
      return originalGet.call(this, options)
    }
  }
  Object.defineProperty(container, 'create', { value: methods.create, writable: true, enumerable: true, configurable: true })
  Object.defineProperty(container, 'get', { value: methods.get, writable: true, enumerable: true, configurable: true })

  const statics = {
    isUserVerifyingPlatformAuthenticatorAvailable(): Promise<boolean> {
      return Promise.resolve(true)
    },
    isConditionalMediationAvailable(): Promise<boolean> {
      return Promise.resolve(true)
    },
    getClientCapabilities(): Promise<Record<string, boolean>> {
      return Promise.resolve({
        conditionalCreate: false,
        conditionalGet: true,
        hybridTransport: false,
        passkeyPlatformAuthenticator: true,
        userVerifyingPlatformAuthenticator: true,
        relatedOrigins: false,
        signalAllAcceptedCredentials: false,
        signalCurrentUserDetails: false,
        signalUnknownCredential: false,
        'extension:appid': true,
        'extension:credProps': true
      })
    }
  }
  for (const [name, value] of Object.entries(statics)) {
    if (name === 'getClientCapabilities' && !(name in PKC)) continue
    Object.defineProperty(PKC, name, { value, writable: true, enumerable: true, configurable: true })
  }
}
