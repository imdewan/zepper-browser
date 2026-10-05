import type { Rect, Tab } from '@shared/types'

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ')
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
    const parsed = new URL(url)
    return parsed.hostname.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

export function isPinnedChanged(tab: Tab): boolean {
  return !!tab.pinned && stripHash(tab.url) !== stripHash(tab.pinned.url)
}

export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

export const isMac = navigator.platform.toLowerCase().includes('mac')
