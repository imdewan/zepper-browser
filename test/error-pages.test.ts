/// <reference types="node" />
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ERROR_TITLES, crashError, describeError, errorPage } from '../src/main/error-pages'

const html = (dataUrl: string): string => decodeURIComponent(dataUrl.replace(/^data:text\/html;charset=utf-8,/, ''))

test('each failure says what went wrong, as Chrome does', () => {
  assert.equal(describeError(-105).message, '{host}’s server address couldn’t be found.')
  assert.equal(describeError(-102).message, '{host} refused to connect.')
  assert.equal(describeError(-118).message, '{host} took too long to respond.')
  assert.equal(describeError(-310).message, '{host} redirected you too many times.')
  assert.equal(describeError(-324).message, '{host} didn’t send any data.')
  assert.equal(describeError(-106).title, 'No internet')
  assert.equal(describeError(-6).title, 'Your file couldn’t be opened')
  assert.equal(describeError(-201).title, 'Your connection isn’t private')
})

test('codes Zepper has no words for still get a page', () => {
  assert.equal(describeError(-999).title, 'This site can’t be reached')
  assert.equal(describeError(-299).certificate, true)
})

test('the page names the site and shows the code', () => {
  const page = html(errorPage('https://example.com/a?b=1', describeError(-105), 'ERR_NAME_NOT_RESOLVED'))
  assert.match(page, /<h1>This site can&#8217;t be reached<\/h1>|<h1>This site can’t be reached<\/h1>/)
  assert.match(page, /<strong>example\.com<\/strong>/)
  assert.match(page, /<li>Check the address for a typo<\/li>/)
  assert.match(page, /ERR_NAME_NOT_RESOLVED/)
  assert.match(page, /<button id="reload">Reload<\/button>/)
})

test('a connection failure tries again once the Mac is back online', () => {
  assert.match(html(errorPage('https://a.com/', describeError(-106), 'ERR_INTERNET_DISCONNECTED')), /addEventListener\('online', retry\)/)
  assert.doesNotMatch(html(errorPage('https://a.com/', describeError(-310), 'ERR_TOO_MANY_REDIRECTS')), /'online'/)
})

test('a certificate error offers no way round it, and shows its code as Chrome does', () => {
  const page = html(errorPage('https://expired.example/', describeError(-201), 'ERR_CERT_DATE_INVALID'))
  assert.doesNotMatch(page, /<button/)
  assert.match(page, /NET::ERR_CERT_DATE_INVALID/)
  assert.match(page, /date and time/)
})

test('a missing file says it may have moved, with no Reload to try', () => {
  const page = html(errorPage('file:///Users/me/My%20Notes.html', describeError(-6), 'ERR_FILE_NOT_FOUND'))
  assert.match(page, /It may have been moved, renamed or deleted\./)
  assert.doesNotMatch(page, /<button/)
})

test('an address with markup in it stays text', () => {
  const page = html(errorPage('https://a.com/</script><script>alert(1)</script>', describeError(-102), 'ERR_CONNECTION_REFUSED'))
  assert.doesNotMatch(page, /<\/script><script>alert/)
  assert.match(page, /\\u003c\/script>/)
})

test('restored tabs lose any error title, old or new', () => {
  for (const title of ['Can’t reach this page', 'No internet', 'Your connection isn’t private', crashError().title]) {
    assert.ok(ERROR_TITLES.has(title), title)
  }
})

test('each page has its picture: red for a connection that isn’t safe', () => {
  assert.match(html(errorPage('https://a.com/', describeError(-105), 'ERR_NAME_NOT_RESOLVED')), /<svg class="icon" /)
  assert.match(html(errorPage('https://a.com/', describeError(-201), 'ERR_CERT_DATE_INVALID')), /<svg class="icon danger" /)
  assert.equal(describeError(-106).icon, 'offline')
  assert.equal(describeError(-6).icon, 'file')
  assert.equal(describeError(-310).icon, 'broken')
  assert.equal(crashError().icon, 'crash')
})

test('a port browsers never use says so', () => {
  assert.equal(describeError(-312).message, '{host} uses a port Zepper doesn’t open web pages on.')
})
