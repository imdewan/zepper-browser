import type { Session } from 'electron'

/**
 * A page's title and icon without loading it: the start of its HTML (up to the end of <head>),
 * fetched with the tab's sign-ins. For tabs that haven't been opened yet, so they show their name
 * and icon instead of an address, and nothing starts playing.
 */

// YouTube's <title> comes after some 700 KB of inline script; the rest of the page is never read.
const MAX_BYTES = 1024 * 1024
const TIMEOUT_MS = 8000

export interface PageMeta {
  title: string | null
  favicon: string | null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match
    }
    return ENTITIES[code.toLowerCase()] ?? match
  })
}

const attribute = (tag: string, name: string): string | null =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
    .exec(tag)
    ?.slice(1)
    .find((v) => v !== undefined) ?? null

/** The title and the best icon from a page's head. */
export function parseHead(html: string, pageUrl: string): PageMeta {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const og = /<meta[^>]+property\s*=\s*["']og:title["'][^>]*>/i.exec(html)?.[0]
  const clean = (text: string | null | undefined): string => decodeEntities((text ?? '').replace(/\s+/g, ' ').trim())
  const title = clean(raw) || clean(og && attribute(og, 'content')) || null

  // Icons: a scalable one, else the largest "icon", else an Apple touch icon, else /favicon.ico.
  const icons = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((m) => m[0])
    .map((tag) => ({
      rel: (attribute(tag, 'rel') ?? '').toLowerCase(),
      href: attribute(tag, 'href'),
      sizes: attribute(tag, 'sizes'),
      type: attribute(tag, 'type')
    }))
    .filter((link) => link.href && /\bicon\b/.test(link.rel))
  const size = (sizes: string | null): number => Math.max(0, ...(sizes ?? '').split(/\s+/).map((s) => parseInt(s, 10) || 0))
  const plain = icons.filter((i) => !i.rel.includes('apple') && !i.rel.includes('mask'))
  const best =
    plain.find((i) => i.type === 'image/svg+xml' || /\.svg(\?|$)/i.test(i.href!)) ??
    plain.sort((a, b) => size(b.sizes) - size(a.sizes))[0] ??
    icons.find((i) => i.rel.includes('apple-touch-icon'))
  let favicon: string | null = null
  try {
    favicon = new URL(best?.href ?? '/favicon.ico', pageUrl).href
  } catch {
    favicon = null
  }
  return { title, favicon }
}

/** Fetches and reads a page's head; null when it can't be reached or isn't a web page. */
export async function fetchPageMeta(ses: Session, url: string): Promise<PageMeta | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await ses.fetch(url, { signal: controller.signal, headers: { Accept: 'text/html,application/xhtml+xml' } })
    if (!response.ok || !response.body || !/html/i.test(response.headers.get('content-type') ?? '')) {
      return { title: null, favicon: new URL('/favicon.ico', response.url || url).href }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let html = ''
    let bytes = 0
    while (bytes < MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.length
      html += decoder.decode(value, { stream: true })
      if (/<\/head>/i.test(html)) break
    }
    void reader.cancel().catch(() => {})
    return parseHead(html, response.url || url)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
