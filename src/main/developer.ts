import type { Settings } from '@shared/settings'

/**
 * Developer Mode (as in Arc): a site you're building gets the developer bar over its page, with its
 * full address, DevTools and Portrait Mode. It's on for local sites, and for any site you turn it on
 * for, by its host, from then on.
 */

/** The host Developer Mode is decided by: the address's, without "www." (any port). */
export function developerHost(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return (
      parsed.hostname
        .toLowerCase()
        .replace(/^www\./, '')
        .replace(/^\[|\]$/g, '') || null
    )
  } catch {
    return null
  }
}

/** A site on this Mac or your network: localhost, *.localhost, *.local, *.test, loopback and private addresses. */
export function isLocalHost(host: string): boolean {
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return true
  if (/\.(localhost|local|test)$/.test(host)) return true
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!ip) return false
  const [a, b] = [Number(ip[1]), Number(ip[2])]
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/** Whether a page gets the developer bar. */
export function isDeveloping(url: string, settings: Pick<Settings, 'developerMode' | 'developerSites' | 'notDeveloperSites'>): boolean {
  if (!settings.developerMode) return false
  const host = developerHost(url)
  if (!host) return false
  if (settings.developerSites.includes(host)) return true
  return isLocalHost(host) && !settings.notDeveloperSites.includes(host)
}

/** The settings change that turns Developer Mode on or off for a host. */
export function toggleDeveloperHost(
  host: string,
  on: boolean,
  settings: Pick<Settings, 'developerSites' | 'notDeveloperSites'>
): Pick<Settings, 'developerSites' | 'notDeveloperSites'> {
  const sites = settings.developerSites.filter((h) => h !== host)
  const off = settings.notDeveloperSites.filter((h) => h !== host)
  if (isLocalHost(host)) return { developerSites: sites, notDeveloperSites: on ? off : [...off, host] }
  return { developerSites: on ? [...sites, host] : sites, notDeveloperSites: off }
}
