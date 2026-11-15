/// <reference types="node" />
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  countPdfPages,
  defaultPrintSettings,
  pageSizeLabel,
  parsePageRanges,
  pdfOptions,
  printerOptions,
  stickySettings
} from '../src/main/print-options'

const defaults = defaultPrintSettings('IN')

test('pages are read as Chrome reads them', () => {
  assert.deepEqual(parsePageRanges('1-5, 8, 11-13'), [
    { from: 1, to: 5 },
    { from: 8, to: 8 },
    { from: 11, to: 13 }
  ])
  assert.deepEqual(parsePageRanges(' 2 , 4 '), [
    { from: 2, to: 2 },
    { from: 4, to: 4 }
  ])
  assert.deepEqual(parsePageRanges('3-', 5), [{ from: 3, to: 5 }])
})

test('pages that are not pages, or past the end, are refused', () => {
  for (const text of ['', ' , ', 'abc', '0', '5-2', '1-2-3', '-4']) assert.equal(parsePageRanges(text, 10), null, text)
  assert.equal(parsePageRanges('1-6', 5), null)
  assert.equal(parsePageRanges('3-'), null)
})

test("a PDF's pages are counted, not its page tree", () => {
  const pdf = new TextEncoder().encode(
    '%PDF-1.4\n1 0 obj <</Type /Pages /Kids [2 0 R 3 0 R] /Count 2>> endobj\n2 0 obj <</Type /Page /Parent 1 0 R>> endobj\n3 0 obj <</Type/Page /Parent 1 0 R>> endobj\n'
  )
  assert.equal(countPdfPages(pdf), 2)
  assert.equal(countPdfPages(new TextEncoder().encode('not a pdf')), null)
})

test('paper starts as the country uses it', () => {
  assert.equal(defaultPrintSettings('US').paper, 'Letter')
  assert.equal(defaultPrintSettings('IN').paper, 'A4')
  assert.equal(defaults.destination, 'pdf')
  assert.equal(defaults.headersFooters, true)
  assert.equal(defaults.backgrounds, false)
})

test('choices carry over from the last print, but pages and copies start over', () => {
  const kept = stickySettings({ destination: 'Office', backgrounds: true, scale: 80, pages: 'custom', range: '2', copies: 3 }, defaults)
  assert.equal(kept.destination, 'Office')
  assert.equal(kept.backgrounds, true)
  assert.equal(kept.scale, 80)
  assert.equal(kept.pages, 'all')
  assert.equal(kept.range, '')
  assert.equal(kept.copies, 1)
  const junk = stickySettings({ paper: 'B9', margins: 'wide', scale: 900, landscape: 'yes' }, defaults)
  assert.deepEqual(junk, defaults)
  assert.deepEqual(stickySettings(null, defaults), defaults)
})

test('the PDF follows the choices', () => {
  const options = pdfOptions({ ...defaults, scale: 80, backgrounds: true, landscape: true }, [
    { from: 1, to: 3 },
    { from: 5, to: 5 }
  ])
  assert.equal(options.scale, 0.8)
  assert.equal(options.printBackground, true)
  assert.equal(options.landscape, true)
  assert.equal(options.pageRanges, '1-3,5')
  assert.equal(options.pageSize, 'A4')
  assert.equal(options.preferCSSPageSize, false)
  assert.equal(options.displayHeaderFooter, true)
})

test('without margins there are no headers and footers', () => {
  const options = pdfOptions({ ...defaults, margins: 'none' })
  assert.deepEqual(options.margins, { top: 0, bottom: 0, left: 0, right: 0 })
  assert.equal(options.displayHeaderFooter, false)
})

test("on the page's own size, the page decides; on other paper, it's scaled to fit", () => {
  const own = pdfOptions({ ...defaults, paper: 'page', landscape: true })
  assert.equal(own.pageSize, undefined)
  assert.equal(own.landscape, undefined)
  assert.equal(own.preferCSSPageSize, true)
  const letter = pdfOptions({ ...defaults, paper: 'Letter', landscape: true })
  assert.equal(letter.pageSize, 'Letter')
  assert.equal(letter.landscape, true)
  assert.equal(letter.preferCSSPageSize, false)
  const printer = printerOptions(
    { ...defaults, destination: 'Office', paper: 'page', landscape: true },
    undefined,
    'Invoice',
    'file:///a.html'
  )
  assert.equal(printer.landscape, undefined)
  assert.equal(printer.pageSize, undefined)
})

test("a page's own size reads as the panel shows it", () => {
  assert.equal(pageSizeLabel('A4 portrait'), 'A4')
  assert.equal(pageSizeLabel('letter landscape'), 'Letter landscape')
  assert.equal(pageSizeLabel('210mm 297mm'), '210mm × 297mm')
  assert.equal(pageSizeLabel('landscape'), 'Landscape')
  assert.equal(pageSizeLabel('auto'), null)
  assert.equal(pageSizeLabel(''), null)
})

test('printing on a printer counts pages from 0, and keeps copies sensible', () => {
  const options = printerOptions({ ...defaults, destination: 'Office', copies: 5000 }, [{ from: 2, to: 4 }], 'Invoice', 'https://a.com/')
  assert.deepEqual(options.pageRanges, [{ from: 1, to: 3 }])
  assert.equal(options.copies, 999)
  assert.equal(options.silent, true)
  assert.equal(options.deviceName, 'Office')
  assert.equal(options.header, 'Invoice')
  assert.equal(options.footer, 'https://a.com/')
})
