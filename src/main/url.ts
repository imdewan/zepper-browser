import { SEARCH_ENGINES, type SearchEngineId } from '@shared/settings'
import { bangs } from './bangs'

let engine: SearchEngineId = 'google'

export function setSearchEngine(id: SearchEngineId): void {
  engine = id
}

export function searchEngineName(): string {
  return SEARCH_ENGINES[engine].name
}

export function suggestUrl(query: string): string | null {
  const template = SEARCH_ENGINES[engine].suggest
  return template ? template.replace('%s', encodeURIComponent(query)) : null
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const HOST_LIKE = /^(localhost|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z]{2,})(:\d+)?(\/.*)?$/i

export function searchUrl(query: string): string {
  return SEARCH_ENGINES[engine].search.replace('%s', encodeURIComponent(query))
}

/** Whether typed text should be treated as a URL rather than a search. */
export function looksLikeUrl(input: string): boolean {
  const text = input.trim()
  if (!text || /\s/.test(text)) return false
  if (SCHEME.test(text) && !/^[a-z0-9-]+:\d+/i.test(text)) {
    return /^(https?|file|about|data|chrome|view-source):/i.test(text)
  }
  return HOST_LIKE.test(text)
}

/**
 * Turns palette input into a URL: DuckDuckGo bangs go straight to their site,
 * full URLs pass through, hosts get a scheme, anything else is a search.
 */
export function resolveInput(input: string): string {
  const text = input.trim()
  const bang = bangs.resolve(text)
  if (bang) return bang.url
  if (!looksLikeUrl(text)) return searchUrl(text)
  if (SCHEME.test(text) && !/^[a-z0-9-]+:\d+/i.test(text)) return text
  const isLocal = /^(localhost|127\.|\d{1,3}(\.\d{1,3}){3})/i.test(text)
  return `${isLocal ? 'http' : 'https'}://${text}`
}

const TRACKING_PARAMS = [
  /^utm_/,
  /^fbclid$/,
  /^gclid$/,
  /^dclid$/,
  /^msclkid$/,
  /^mc_(cid|eid)$/,
  /^igshid$/,
  /^_hs(enc|mi)$/,
  /^yclid$/,
  /^si$/,
  /^ref_src$/
]

/** Removes common tracking parameters before a URL is copied or shared. */
export function stripTracking(url: string): string {
  try {
    const parsed = new URL(url)
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.some((re) => re.test(key))) parsed.searchParams.delete(key)
    }
    return parsed.toString()
  } catch {
    return url
  }
}

export function stripHash(url: string): string {
  const i = url.indexOf('#')
  return i === -1 ? url : url.slice(0, i)
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
