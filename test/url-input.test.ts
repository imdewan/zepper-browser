/// <reference types="node" />
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { escapeSpaces, looksLikeUrl } from '../src/main/url-input'

const tracking = 'https://www.bluedart.com/web/guest/trackdartresult?trackFor=0&trackNo= 90726994223'

test('a link with its scheme can have spaces after its host', () => {
  assert.equal(looksLikeUrl(tracking), true)
  assert.equal(looksLikeUrl('https://example.com/ is down'), true)
  assert.equal(looksLikeUrl('file:///Users/me/My File.html'), true)
})

test('a space in the host is a search', () => {
  assert.equal(looksLikeUrl('https://my site.com'), false)
  assert.equal(looksLikeUrl('https://example.com is down?'), false)
  assert.equal(looksLikeUrl('https://a.com https://b.com'), false)
  assert.equal(looksLikeUrl('http: something'), false)
})

test('without a scheme, any space is a search', () => {
  assert.equal(looksLikeUrl('what is example.com'), false)
  assert.equal(looksLikeUrl('example.com/a b'), false)
})

test('addresses without spaces are unchanged', () => {
  assert.equal(looksLikeUrl('example.com'), true)
  assert.equal(looksLikeUrl('localhost:3000'), true)
  assert.equal(looksLikeUrl('https://example.com'), true)
  assert.equal(looksLikeUrl('javascript:alert(1)'), false)
  assert.equal(looksLikeUrl('cats'), false)
})

test('spaces are escaped as Chrome does', () => {
  assert.equal(escapeSpaces(tracking), 'https://www.bluedart.com/web/guest/trackdartresult?trackFor=0&trackNo=%2090726994223')
  assert.equal(escapeSpaces('file:///Users/me/My File.html'), 'file:///Users/me/My%20File.html')
  assert.equal(escapeSpaces('https://example.com/a'), 'https://example.com/a')
})
