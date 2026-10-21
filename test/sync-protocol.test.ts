/// <reference types="node" />
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  base64url,
  codeLink,
  decodeCode,
  deriveKeys,
  documentId,
  encodeCode,
  fromBase64url,
  newSecret,
  open,
  seal,
  type SyncRecord
} from '../src/shared/sync-protocol'

// The same vectors are in the iPhone app's tests: both must read what the other writes.
const vectors = JSON.parse(readFileSync(new URL('./sync-vectors.json', import.meta.url), 'utf8'))

test('derives the same chain, names and sealed records as the iPhone app', () => {
  const secret = fromBase64url(vectors.secret)
  const keys = deriveKeys(secret)
  assert.equal(keys.chainId, vectors.chainId)
  assert.equal(documentId(keys, 'pin', vectors.record.id), vectors.docId)
  assert.equal(seal(keys, vectors.docId, vectors.record, fromBase64url(vectors.nonce)), vectors.sealed)
  assert.deepEqual(open(keys, vectors.docId, vectors.sealed), vectors.record)
  assert.equal(encodeCode(secret), vectors.code)
  assert.equal(codeLink(secret), vectors.link)
})

test('reads a code however it was typed or scanned', () => {
  const secret = fromBase64url(vectors.secret)
  for (const input of [vectors.code, vectors.code.toLowerCase(), vectors.code.replace(/-/g, ' '), vectors.link, `  ${vectors.code}\n`]) {
    assert.deepEqual(decodeCode(input), secret, input)
  }
  // Letters people mix up read as the digits they look like.
  assert.deepEqual(decodeCode(vectors.code.replace(/1/g, 'l').replace(/0/g, 'O')), secret)
  assert.equal(decodeCode('1CR5-AYMZ'), null)
  assert.equal(decodeCode(vectors.code.slice(0, -1) + 'U'), null)
})

test('round-trips every kind of record, and new secrets', () => {
  const keys = deriveKeys(newSecret())
  const records: SyncRecord[] = [
    { type: 'space', id: 's', name: 'Work', icon: '💼', theme: { colors: ['#2d6cdf'], opacity: 0.6, texture: 0 }, order: 'a0' },
    { type: 'folder', id: 'f', spaceId: 's', parentId: null, order: 'a1', name: 'Docs' },
    { type: 'device', id: 'd', name: 'iPhone', platform: 'ios', seenAt: 1, tabs: [{ url: 'https://a.com/', title: 'A', spaceId: 's' }] },
    { type: 'send', id: 'x', to: 'd', from: 'e', url: 'https://b.com/', title: 'B', at: 2 }
  ]
  for (const record of records) {
    const id = documentId(keys, record.type, record.id)
    assert.deepEqual(open(keys, id, seal(keys, id, record)), record)
  }
  assert.equal(base64url(fromBase64url('AQID_-8')), 'AQID_-8')
})

test("won't open what's been tampered with, moved, or sealed with another code", () => {
  const keys = deriveKeys(fromBase64url(vectors.secret))
  const other = deriveKeys(newSecret())
  const flipped = vectors.sealed.slice(0, 40) + (vectors.sealed[40] === 'A' ? 'B' : 'A') + vectors.sealed.slice(41)
  assert.equal(open(keys, vectors.docId, flipped), null)
  assert.equal(open(keys, documentId(keys, 'pin', 'another'), vectors.sealed), null)
  assert.equal(open(other, vectors.docId, vectors.sealed), null)
  assert.equal(open(keys, vectors.docId, 'not base64!'), null)
})
