import type { PrintToPDFOptions, WebContentsPrintOptions } from 'electron'
import type { PaperSize, PrintSettings } from '@shared/types'

export const PAPER_SIZES: PaperSize[] = ['A3', 'A4', 'A5', 'Legal', 'Letter', 'Tabloid']

/** Where Letter is the usual paper; everywhere else it's A4, as Chrome picks by country. */
const LETTER_COUNTRIES = new Set(['US', 'CA', 'MX', 'PH', 'PR', 'CL', 'CO', 'CR', 'DO', 'GT', 'NI', 'PA', 'SV', 'VE', 'BZ'])

/** Chrome's starting choices: Save as PDF, the country's paper, headers and footers on, backgrounds off. */
export function defaultPrintSettings(country: string): PrintSettings {
  return {
    destination: 'pdf',
    pages: 'all',
    range: '',
    copies: 1,
    landscape: false,
    color: true,
    paper: LETTER_COUNTRIES.has(country.toUpperCase()) ? 'Letter' : 'A4',
    margins: 'default',
    scale: 100,
    headersFooters: true,
    backgrounds: false
  }
}

/**
 * Choices kept from the last print (anything that isn't one is left at its default). As in Chrome,
 * which pages and how many copies start over each time.
 */
export function stickySettings(saved: unknown, defaults: PrintSettings): PrintSettings {
  const s = saved && typeof saved === 'object' ? (saved as Partial<Record<keyof PrintSettings, unknown>>) : {}
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
  return {
    ...defaults,
    destination: typeof s.destination === 'string' && s.destination ? s.destination : defaults.destination,
    landscape: bool(s.landscape, defaults.landscape),
    color: bool(s.color, defaults.color),
    paper: PAPER_SIZES.includes(s.paper as PaperSize) ? (s.paper as PaperSize) : defaults.paper,
    margins: s.margins === 'none' || s.margins === 'default' ? s.margins : defaults.margins,
    scale: validScale(s.scale) ? (s.scale as number) : defaults.scale,
    headersFooters: bool(s.headersFooters, defaults.headersFooters),
    backgrounds: bool(s.backgrounds, defaults.backgrounds)
  }
}

/**
 * A page's CSS @page size as the panel shows it ("A4 portrait" → "A4", "letter landscape" → "Letter
 * landscape", "210mm 297mm" → "210mm × 297mm"); null when it leaves the size to the printer ("auto").
 */
export function pageSizeLabel(css: string): string | null {
  const words = css.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0 || words[0] === 'auto') return null
  const named = PAPER_SIZES.find((size) => words.includes(size.toLowerCase()))
  const landscape = words.includes('landscape')
  if (named) return landscape ? `${named} landscape` : named
  const lengths = words.filter((w) => w !== 'portrait' && w !== 'landscape')
  if (lengths.length === 0) return landscape ? 'Landscape' : 'Portrait'
  return lengths.join(' × ')
}

export function validScale(scale: unknown): boolean {
  return typeof scale === 'number' && Number.isInteger(scale) && scale >= 10 && scale <= 200
}

export type PageRanges = { from: number; to: number }[]

/**
 * Pages written as in Chrome ("1-5, 8, 11-13", or "3-" for the rest), 1-based; null when it doesn't
 * read as pages, or asks for pages past the end. Without the page count, "3-" can't be read.
 */
export function parsePageRanges(text: string, pageCount?: number): PageRanges | null {
  const parts = text.split(',').map((p) => p.trim())
  if (parts.every((p) => !p)) return null
  const ranges: PageRanges = []
  for (const part of parts) {
    if (!part) continue
    const match = /^(\d+)\s*(?:(-)\s*(\d*))?$/.exec(part)
    if (!match) return null
    const from = Number(match[1])
    const to = match[2] ? (match[3] ? Number(match[3]) : pageCount) : from
    if (to === undefined || from < 1 || to < from) return null
    if (pageCount !== undefined && to > pageCount) return null
    ranges.push({ from, to })
  }
  return ranges
}

/** Pages in a PDF Chromium made (its page objects); null when none can be found. */
export function countPdfPages(pdf: Uint8Array): number | null {
  const text = new TextDecoder('latin1').decode(pdf)
  const pages = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0
  return pages > 0 ? pages : null
}

/** Chrome's headers and footers: the date and title along the top, the address and page number along the bottom. */
const HEADER_STYLE =
  'font: 8px system-ui, -apple-system, sans-serif; width: 100%; margin: 0 0.4in; display: grid; grid-template-columns: 1fr auto 1fr; gap: 16px;'
const CLIP = 'overflow: hidden; white-space: nowrap; text-overflow: ellipsis;'
const HEADER = `<div style="${HEADER_STYLE}"><span class="date"></span><span class="title" style="${CLIP}"></span><span></span></div>`
const FOOTER = `<div style="${HEADER_STYLE}"><span class="url" style="grid-column: 1 / 3; ${CLIP}"></span><span style="text-align: right"><span class="pageNumber"></span>/<span class="totalPages"></span></span></div>`

/**
 * The PDF for the preview (and for Save as PDF): on the page's own size, or on the paper you chose with
 * the page scaled to fit it, as Chrome prints. `ranges`: only those pages (checked against the page count already).
 */
export function pdfOptions(settings: PrintSettings, ranges?: PageRanges): PrintToPDFOptions {
  const noMargins = settings.margins === 'none'
  // undefined: the page's own size.
  const paper = settings.paper === 'page' ? undefined : settings.paper
  return {
    pageSize: paper,
    landscape: paper && settings.landscape,
    preferCSSPageSize: !paper,
    printBackground: settings.backgrounds,
    scale: settings.scale / 100,
    margins: noMargins ? { top: 0, bottom: 0, left: 0, right: 0 } : undefined,
    pageRanges: ranges ? ranges.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`)).join(',') : undefined,
    // Without margins there's nowhere to put them (Chrome turns them off too).
    displayHeaderFooter: settings.headersFooters && !noMargins,
    headerTemplate: HEADER,
    footerTemplate: FOOTER
  }
}

/** Printing on a printer, without the system dialog. */
export function printerOptions(
  settings: PrintSettings,
  ranges: PageRanges | undefined,
  title: string,
  url: string
): WebContentsPrintOptions {
  const paper = settings.paper === 'page' ? undefined : settings.paper
  return {
    silent: true,
    deviceName: settings.destination,
    printBackground: settings.backgrounds,
    color: settings.color,
    margins: { marginType: settings.margins === 'none' ? 'none' : 'default' },
    landscape: paper && settings.landscape,
    pageSize: paper,
    scaleFactor: settings.scale,
    copies: Math.max(1, Math.min(999, Math.round(settings.copies) || 1)),
    collate: true,
    pageRanges: ranges?.map((r) => ({ from: r.from - 1, to: r.to - 1 })),
    header: settings.headersFooters ? title : undefined,
    footer: settings.headersFooters ? url : undefined
  }
}
