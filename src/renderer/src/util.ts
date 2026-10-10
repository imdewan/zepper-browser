import { shortcutLabel } from '@shared/shortcuts'
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

/** How far this view sits from the window's left edge (the overlay moves during a right-hand peek). */
let viewOffsetX = 0

export function setViewOffsetX(x: number): void {
  viewOffsetX = x
}

/** An element's rect in window coordinates, which is what main and popups expect. */
export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { x: r.left + viewOffsetX, y: r.top, width: r.width, height: r.height }
}

export const isMac = navigator.platform.toLowerCase().includes('mac')
/** Linux: Zepper draws the window's buttons and the window is solid (no system material behind it). */
export const isLinux = navigator.platform.toLowerCase().includes('linux')

/** How Zepper refers to the computer: "this Mac" on a Mac. */
export const THIS_COMPUTER = isMac ? 'this Mac' : 'this computer'
export const YOUR_COMPUTER = isMac ? 'your Mac' : 'your computer'

/** Finder on a Mac; the file manager elsewhere (as Chrome on Linux says it). */
export const SHOW_IN_FOLDER = isMac ? 'Show in Finder' : 'Show in Folder'

/** ⌘ on a Mac, Ctrl elsewhere: the key held to open in the background, or for a button's other action. */
export function primaryKey(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

/** A shortcut written the Mac way ("⇧⌘T"), as this platform writes it ("Ctrl+Shift+T" on Linux). */
export function shortcut(mac: string): string {
  return shortcutLabel(mac, isMac ? 'darwin' : 'linux')
}

/** Names in a sentence: "Work", "Personal and Work", "Personal, Work and Reading". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
