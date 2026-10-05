import { createHash, randomBytes } from 'node:crypto'
import { parse } from 'tldts-experimental'

/**
 * Privacy protections beyond ad blocking, applied to navigations and requests (see AdBlock,
 * which owns the session's request hooks):
 *
 * - Links are cleaned of click identifiers (fbclid, gclid…) and Google AMP wrappers.
 * - Plain-HTTP pages are upgraded to HTTPS, falling back to HTTP for sites without it.
 * - Third-party requests don't send or receive cookies (see AdBlock.crossSiteCookiesBlocked).
 * - Pages get a per-site, per-session seed for fingerprinting noise (see preload/page.ts).
 */

/** Per-click identifiers that follow you from site to site (not campaign tags like utm_*). */
const CLICK_IDS = new Set([
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  '__hssc',
  '__hstc',
  '__hsfp',
  'mkt_tok',
  'igshid',
  'igsh',
  'yclid',
  'twclid',
  'ttclid',
  'li_fat_id',
  'epik',
  'oly_anon_id',
  'oly_enc_id',
  'vero_id',
  'vero_conv',
  'rb_clickid',
  '_openstat',
  'wickedid',
  'irclickid',
  'srsltid',
  'ndclid',
  '_kx'
])

/** The page a Google AMP viewer or AMP cache URL wraps, if it is one. */
function unwrapAmp(url: URL): string | null {
  // https://www.google.com/amp/s/example.com/page → https://example.com/page
  const viewer = /^\/amp\/(s\/)?(.+)$/.exec(url.pathname)
  if (viewer && /^(www\.)?google\.[a-z.]+$/.test(url.hostname)) return `${viewer[1] ? 'https' : 'http'}://${viewer[2]}${url.search}`
  // https://example-com.cdn.ampproject.org/c/s/example.com/page → https://example.com/page
  const cache = /^\/[a-z]\/(s\/)?(.+)$/.exec(url.pathname)
  if (cache && url.hostname.endsWith('.cdn.ampproject.org')) return `${cache[1] ? 'https' : 'http'}://${cache[2]}${url.search}`
  return null
}

/** A link without click identifiers or AMP wrapping; null when there's nothing to clean. */
export function cleanLink(href: string): string | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const amp = unwrapAmp(url)
  if (amp) return cleanLink(amp) ?? amp
  const keys = [...url.searchParams.keys()].filter((key) => CLICK_IDS.has(key.toLowerCase()))
  if (keys.length === 0) return null
  for (const key of keys) url.searchParams.delete(key)
  return url.href
}

/** Hosts that can't be upgraded: local names and addresses. */
function isLocal(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.test') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
    hostname.includes(':') ||
    !hostname.includes('.')
  )
}

/** HTTPS by default: upgrades plain-HTTP navigations, remembering sites that don't support it. */
export class HttpsUpgrades {
  /** Hosts we've upgraded this session (a failure there falls back to HTTP). */
  private readonly upgraded = new Set<string>()
  /** Hosts that only work over HTTP (this session). */
  private readonly httpOnly = new Set<string>()
  /** URL → when we last upgraded it, to notice HTTPS → HTTP redirect loops. */
  private readonly recent = new Map<string, number>()

  /** The HTTPS address to load instead, or null to load as is. */
  upgrade(href: string): string | null {
    if (!href.startsWith('http:')) return null
    let url: URL
    try {
      url = new URL(href)
    } catch {
      return null
    }
    if (isLocal(url.hostname) || this.httpOnly.has(url.host)) return null
    // The same address back over HTTP within moments means the site redirected us down again.
    const last = this.recent.get(href)
    if (last && Date.now() - last < 5000) {
      this.httpOnly.add(url.host)
      return null
    }
    this.recent.set(href, Date.now())
    if (this.recent.size > 200) this.recent.delete(this.recent.keys().next().value!)
    this.upgraded.add(url.host)
    url.protocol = 'https:'
    return url.href
  }

  /** After an upgraded page failed to load: the HTTP address to try instead, or null. */
  fallback(href: string, errorCode: number): string | null {
    let url: URL
    try {
      url = new URL(href)
    } catch {
      return null
    }
    // Aborted loads and unknown hosts won't work over HTTP either.
    if (url.protocol !== 'https:' || !this.upgraded.has(url.host) || errorCode === -3 || errorCode === -105) return null
    this.httpOnly.add(url.host)
    url.protocol = 'http:'
    return url.href
  }
}

/** A new secret each launch, so fingerprinting noise can't be linked across sessions. */
const sessionSecret = randomBytes(16)

/** The fingerprinting-noise seed for a page: the same across one site this session, different elsewhere. */
export function fingerprintSeed(pageUrl: string): number {
  const { domain, hostname } = parse(pageUrl)
  return createHash('sha256')
    .update(sessionSecret)
    .update(domain || hostname || '')
    .digest()
    .readUInt32LE(0)
}
