import { SEARCH_ENGINES, type SearchEngineId } from '@shared/settings'
import { bangs } from './bangs'
import { escapeSpaces, hasScheme, looksLikeUrl } from './url-input'

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

export function searchUrl(query: string): string {
  return SEARCH_ENGINES[engine].search.replace('%s', encodeURIComponent(query))
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
  if (hasScheme(text)) return escapeSpaces(text)
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

/** A URL without its #fragment, normalised (so `https://a.com` and `https://a.com/` match). */
export function stripHash(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.href
  } catch {
    const i = url.indexOf('#')
    return i === -1 ? url : url.slice(0, i)
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
