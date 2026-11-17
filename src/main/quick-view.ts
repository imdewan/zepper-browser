import { parse } from 'tldts-experimental'
import type { QuickViewMode } from '@shared/settings'

/**
 * Quick View: a link opens in a preview over the page you're on, which you can close, or open as a tab
 * or beside the page in split view. The page preload asks over this channel, as you click a link,
 * whether it opens there instead of where it was going (the answer has to come before the click ends).
 */
export const QUICK_VIEW_CHANNEL = 'zepper:quick-view'

/** The rounding of the card's corners, which are its page's (overlay.css .quick-view). */
export const QUICK_VIEW_RADIUS = 12

/** A site as Chrome counts one: its registrable domain (example.co.uk), or its host where there's none (localhost). */
function siteOf(url: string): string | null {
  try {
    const { hostname, protocol } = new URL(url)
    if (protocol !== 'https:' && protocol !== 'http:') return null
    // With the list's private part (github.io, vercel.app…), where each name is its own site, as in Chrome.
    return parse(hostname, { allowPrivateDomains: true }).domain ?? hostname
  } catch {
    return null
  }
}

const withoutHash = (url: string): string => url.replace(/#.*$/, '')

/**
 * Whether a link you clicked on `page` opens in Quick View. `modifier`: you held ⌥ (Alt) as you clicked,
 * which opens any link there unless Quick View is off. On 'click', a link to another site does too; a link
 * within the site goes on as usual, as does one to a place on the same page.
 */
export function opensInQuickView(mode: QuickViewMode, link: string, page: string, modifier: boolean): boolean {
  if (mode === 'off') return false
  const target = siteOf(link)
  if (!target || withoutHash(link) === withoutHash(page)) return false
  if (modifier) return true
  if (mode !== 'click') return false
  const here = siteOf(page)
  return here !== null && here !== target
}
