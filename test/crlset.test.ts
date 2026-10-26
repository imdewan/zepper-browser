/// <reference types="node" />
import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'

import { CrlSet, fileFromCrx, normalSerial, parseCrlSet } from '../src/main/crlset'

// A chain signed by one of eMudhra's compromised intermediates (EM DV TLS CA - G3B).
const chain = JSON.parse(readFileSync(new URL('./crlset-chain.json', import.meta.url), 'utf8')) as { leaf: string; intermediate: string }

const spkiOf = (pem: string): Buffer =>
  createHash('sha256')
    .update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' }))
    .digest()

/** A CRLSet as Chrome's are made: a length-prefixed JSON header, then issuers' revoked serials. */
function crlset(header: Record<string, unknown>, revoked: [Buffer, Buffer[]][] = []): Buffer {
  const json = Buffer.from(JSON.stringify({ Version: 0, ContentType: 'CRLSet', DeltaFrom: 0, NumParents: revoked.length, ...header }))
  const parts = [Buffer.alloc(2), json]
  parts[0].writeUInt16LE(json.length)
  for (const [issuer, serials] of revoked) {
    const count = Buffer.alloc(4)
    count.writeUInt32LE(serials.length)
    parts.push(issuer, count, ...serials.flatMap((s) => [Buffer.from([s.length]), s]))
  }
  return Buffer.concat(parts)
}

/** Electron's Certificate, as much of it as the check reads. */
function electronChain(): Electron.Certificate {
  const fingerprint = (pem: string): string => new X509Certificate(pem).fingerprint256
  const intermediate = { data: chain.intermediate, fingerprint: fingerprint(chain.intermediate) } as Electron.Certificate
  return { data: chain.leaf, fingerprint: fingerprint(chain.leaf), issuerCert: intermediate } as Electron.Certificate
}

async function loaded(bytes: Buffer): Promise<CrlSet> {
  const folder = mkdtempSync(join(tmpdir(), 'zepper-crlset-'))
  writeFileSync(join(folder, 'crlset.bin'), bytes)
  const set = new CrlSet()
  await set.start(folder)
  set.stop()
  return set
}

test('serials compare as Chromium compares them', () => {
  assert.equal(normalSerial('00:0A:ff'), '0aff')
  assert.equal(normalSerial('000001'), '01')
  assert.equal(normalSerial('ABC'), '0abc')
})

test('a CRLSet is read: blocked keys, and serials by issuer', () => {
  const issuer = Buffer.alloc(32, 7)
  const parsed = parseCrlSet(
    crlset({ Sequence: 42, BlockedSPKIs: ['AAAA'], BlockedInterceptionSPKIs: ['BBBB'] }, [
      [issuer, [Buffer.from([0, 1, 2]), Buffer.from([9])]]
    ])
  )
  assert.equal(parsed.sequence, 42)
  assert.deepEqual([...parsed.blocked].sort(), ['AAAA', 'BBBB'])
  assert.deepEqual([...parsed.revoked.get(issuer.toString('base64'))!].sort(), ['0102', '09'])
})

test('a chain through a blocked key is refused, and one without it isn’t', async () => {
  const blocked = await loaded(crlset({ Sequence: 1, BlockedSPKIs: [spkiOf(chain.intermediate).toString('base64')] }))
  assert.equal(blocked.refuses(electronChain()), true)
  assert.equal(blocked.status()?.sequence, 1)
  const other = await loaded(crlset({ Sequence: 2, BlockedSPKIs: [Buffer.alloc(32).toString('base64')] }))
  assert.equal(other.refuses(electronChain()), false)
})

test('a certificate its issuer revoked is refused', async () => {
  const serial = Buffer.from(new X509Certificate(chain.leaf).serialNumber, 'hex')
  const revoked = await loaded(crlset({ Sequence: 3, BlockedSPKIs: [] }, [[spkiOf(chain.intermediate), [serial]]]))
  assert.equal(revoked.refuses(electronChain()), true)
})

test('the CRLSet comes out of the CRX package Chrome’s updater serves', () => {
  const body = Buffer.from('the crl-set')
  const data = deflateRawSync(body)
  const name = Buffer.from('crl-set')
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(body.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(body.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(0, 42)
  const directoryAt = local.length + name.length + data.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(directoryAt, 16)
  const zip = Buffer.concat([local, name, data, central, name, end])
  const header = Buffer.from('signed header')
  const crx = Buffer.concat([Buffer.from('Cr24'), Buffer.from([3, 0, 0, 0]), Buffer.from([header.length, 0, 0, 0]), header, zip])
  assert.equal(fileFromCrx(crx, 'crl-set')?.toString(), 'the crl-set')
  assert.equal(fileFromCrx(crx, 'other'), null)
  assert.equal(fileFromCrx(Buffer.from('not a crx'), 'crl-set'), null)
})
