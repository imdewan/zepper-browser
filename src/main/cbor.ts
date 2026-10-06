/**
 * CBOR (RFC 8949), as WebAuthn and CTAP2 use it: integers, byte and text strings, arrays, maps,
 * booleans and null. Maps encode in CTAP2's canonical order (shorter keys first, then bytewise),
 * which authenticators may insist on.
 */

export type CborValue = number | bigint | string | boolean | null | Uint8Array | CborValue[] | Map<CborValue, CborValue>

function head(major: number, n: number | bigint): Buffer {
  const value = BigInt(n)
  if (value < 24n) return Buffer.from([(major << 5) | Number(value)])
  if (value < 0x100n) return Buffer.from([(major << 5) | 24, Number(value)])
  if (value < 0x10000n) {
    const b = Buffer.alloc(3)
    b[0] = (major << 5) | 25
    b.writeUInt16BE(Number(value), 1)
    return b
  }
  if (value < 0x100000000n) {
    const b = Buffer.alloc(5)
    b[0] = (major << 5) | 26
    b.writeUInt32BE(Number(value), 1)
    return b
  }
  const b = Buffer.alloc(9)
  b[0] = (major << 5) | 27
  b.writeBigUInt64BE(value, 1)
  return b
}

export function encode(value: CborValue): Buffer {
  if (typeof value === 'number' || typeof value === 'bigint') {
    const n = BigInt(value)
    return n >= 0n ? head(0, n) : head(1, -1n - n)
  }
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8')
    return Buffer.concat([head(3, text.length), text])
  }
  if (typeof value === 'boolean') return Buffer.from([value ? 0xf5 : 0xf4])
  if (value === null) return Buffer.from([0xf6])
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value])
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encode)])
  const entries = [...value.entries()].map(([k, v]) => [encode(k), encode(v)] as const)
  entries.sort(([a], [b]) => a.length - b.length || Buffer.compare(a, b))
  return Buffer.concat([head(5, entries.length), ...entries.flat()])
}

/** Decodes one CBOR item; `end` is where it stopped (attested credential data is followed by more). */
export function decode(data: Uint8Array, start = 0): { value: CborValue; end: number } {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  let pos = start
  const length = (info: number): number => {
    if (info < 24) return info
    if (info === 24) return bytes[pos++]
    if (info === 25) return ((pos += 2), bytes.readUInt16BE(pos - 2))
    if (info === 26) return ((pos += 4), bytes.readUInt32BE(pos - 4))
    if (info === 27) return ((pos += 8), Number(bytes.readBigUInt64BE(pos - 8)))
    throw new Error('Unsupported CBOR length')
  }
  const item = (): CborValue => {
    if (pos >= bytes.length) throw new Error('Truncated CBOR')
    const initial = bytes[pos++]
    const major = initial >> 5
    const info = initial & 31
    switch (major) {
      case 0:
        return length(info)
      case 1:
        return -1 - length(info)
      case 2: {
        const n = length(info)
        const value = new Uint8Array(bytes.subarray(pos, pos + n))
        pos += n
        return value
      }
      case 3: {
        const n = length(info)
        const value = bytes.toString('utf8', pos, pos + n)
        pos += n
        return value
      }
      case 4:
        return Array.from({ length: length(info) }, () => item())
      case 5: {
        const n = length(info)
        const map = new Map<CborValue, CborValue>()
        for (let i = 0; i < n; i++) {
          const key = item()
          map.set(key, item())
        }
        return map
      }
      case 6:
        length(info)
        return item()
      default:
        if (info === 20) return false
        if (info === 21) return true
        if (info === 22 || info === 23) return null
        if (info === 25) return ((pos += 2), null)
        if (info === 26) return ((pos += 4), bytes.readFloatBE(pos - 4))
        if (info === 27) return ((pos += 8), bytes.readDoubleBE(pos - 8))
        throw new Error('Unsupported CBOR value')
    }
  }
  const value = item()
  return { value, end: pos }
}
