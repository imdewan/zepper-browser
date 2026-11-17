/// <reference types="node" />
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { opensInQuickView } from '../src/main/quick-view'

test('on Click, a link to another site opens in Quick View', () => {
  assert.equal(opensInQuickView('click', 'https://en.wikipedia.org/wiki/Arc', 'https://www.google.com/search?q=arc', false), true)
  assert.equal(opensInQuickView('click', 'http://example.org/', 'https://news.ycombinator.com/', false), true)
})

test('a link within the site goes on as usual, subdomains and all', () => {
  assert.equal(opensInQuickView('click', 'https://www.google.com/search?q=b', 'https://www.google.com/search?q=a', false), false)
  assert.equal(opensInQuickView('click', 'https://mail.google.com/', 'https://www.google.com/', false), false)
  assert.equal(opensInQuickView('click', 'https://news.bbc.co.uk/a', 'https://www.bbc.co.uk/', false), false)
  // Sites on a shared host (github.io) are each their own.
  assert.equal(opensInQuickView('click', 'https://bob.github.io/', 'https://alice.github.io/', false), true)
})

test('⌥-click opens any link in Quick View, unless it is off', () => {
  assert.equal(opensInQuickView('modifier', 'https://www.google.com/maps', 'https://www.google.com/', true), true)
  assert.equal(opensInQuickView('click', 'https://www.google.com/maps', 'https://www.google.com/', true), true)
  assert.equal(opensInQuickView('modifier', 'https://example.org/', 'https://www.google.com/', false), false)
  assert.equal(opensInQuickView('off', 'https://example.org/', 'https://www.google.com/', true), false)
  assert.equal(opensInQuickView('off', 'https://example.org/', 'https://www.google.com/', false), false)
})

test('only web pages, and not a place on the same page', () => {
  assert.equal(opensInQuickView('click', 'mailto:me@example.org', 'https://www.google.com/', true), false)
  assert.equal(opensInQuickView('click', 'javascript:void(0)', 'https://www.google.com/', true), false)
  assert.equal(opensInQuickView('click', 'https://a.com/page#part', 'https://a.com/page', true), false)
  assert.equal(opensInQuickView('click', 'https://b.com/', 'data:text/html,hi', false), false)
})

test('local sites count by their host', () => {
  assert.equal(opensInQuickView('click', 'http://localhost:5173/about', 'http://localhost:5173/', false), false)
  assert.equal(opensInQuickView('click', 'https://example.org/', 'http://localhost:5173/', false), true)
})
