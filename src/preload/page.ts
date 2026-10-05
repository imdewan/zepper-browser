/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { contextBridge, ipcRenderer, webFrame } from 'electron'

/**
 * Runs in every web page frame before the page's own scripts.
 *
 * 1. Ad blocking: fetches this page's cosmetic filters and scriptlets
 *    synchronously and applies them immediately (document start), the way
 *    Brave and uBlock Origin do. Later, generic class/id rules are requested
 *    for what the page actually renders.
 * 2. Gestures (top frame only): reports two-finger horizontal swipes the page
 *    can't scroll itself, so the browser can slide back/forward.
 */

const COSMETICS_CHANNEL = 'zepper:cosmetics'
const COSMETICS_DOM_CHANNEL = 'zepper:cosmetics-dom'
const SWIPE_CHANNEL = 'zepper:swipe'

interface CosmeticsResponse {
  styles: string
  scripts: string[]
}

// ---- Ad blocking: document-start cosmetics ----------------------------------

function applyCosmetics(): void {
  if (!/^https?:/.test(location.href)) return
  let response: CosmeticsResponse
  try {
    response = ipcRenderer.sendSync(COSMETICS_CHANNEL, location.href) as CosmeticsResponse
  } catch {
    return
  }
  if (response.styles) webFrame.insertCSS(response.styles, { cssOrigin: 'user' })
  if (response.scripts.length > 0) {
    // Compile in this (isolated, CSP-free) world, then run the function in the
    // page's main world. Scriptlets must patch page globals before any page
    // script runs, and page CSP or Trusted Types must not be able to block them.
    const body = response.scripts.map((script) => `try { ${script} } catch (e) {}`).join('\n')
    try {
      contextBridge.executeInMainWorld({ func: new Function(body) as () => void })
    } catch {
      // A broken scriptlet must never break the page.
    }
  }
  watchDomForGenericRules()
}

/** Asks for generic hiding rules matching the classes, ids and links on the page, as it changes. */
function watchDomForGenericRules(): void {
  const seen = { classes: new Set<string>(), ids: new Set<string>(), hrefs: new Set<string>() }
  let timer = 0

  const collect = (root: ParentNode): { classes: string[]; ids: string[]; hrefs: string[] } => {
    const fresh = { classes: [] as string[], ids: [] as string[], hrefs: [] as string[] }
    const elements = root.querySelectorAll('[class],[id],a[href]')
    for (let i = 0; i < elements.length && i < 4000; i++) {
      const el = elements[i]
      for (const name of el.classList) {
        if (!seen.classes.has(name)) {
          seen.classes.add(name)
          fresh.classes.push(name)
        }
      }
      if (el.id && !seen.ids.has(el.id)) {
        seen.ids.add(el.id)
        fresh.ids.push(el.id)
      }
      const href = el instanceof HTMLAnchorElement ? el.getAttribute('href') : null
      if (href && !seen.hrefs.has(href)) {
        seen.hrefs.add(href)
        fresh.hrefs.push(href)
      }
    }
    return fresh
  }

  const flush = async (): Promise<void> => {
    timer = 0
    const fresh = collect(document)
    if (fresh.classes.length + fresh.ids.length + fresh.hrefs.length === 0) return
    try {
      const response = (await ipcRenderer.invoke(COSMETICS_DOM_CHANNEL, { url: location.href, ...fresh })) as CosmeticsResponse
      if (response.styles) webFrame.insertCSS(response.styles, { cssOrigin: 'user' })
    } catch {
      // Ignore: the page just keeps the rules it already has.
    }
  }

  const schedule = (): void => {
    if (!timer) timer = window.setTimeout(() => void flush(), 250)
  }

  document.addEventListener('DOMContentLoaded', () => {
    void flush()
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'] })
  })
}

applyCosmetics()

// ---- Picture-in-picture: "back to tab" -------------------------------------

// Leaving picture-in-picture with the video still playing means "back to tab"
// (closing the PiP window pauses it), so ask the browser to show this tab.
window.addEventListener(
  'leavepictureinpicture',
  (event) => {
    const video = event.target as HTMLVideoElement
    window.setTimeout(() => {
      if (!video.paused) ipcRenderer.send('zepper:pip-back')
    }, 80)
  },
  true
)

// ---- Gestures: swipe to navigate -------------------------------------------

const END_AFTER_MS = 140

function canScrollHorizontally(target: EventTarget | null, delta: number): boolean {
  const scrollable = (el: Element): boolean => {
    if (el.scrollWidth <= el.clientWidth + 1) return false
    return delta < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1
  }
  for (let node = target instanceof Element ? target : null; node && node !== document.documentElement; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowX
    if ((overflow === 'auto' || overflow === 'scroll') && scrollable(node)) return true
  }
  const root = document.scrollingElement
  return !!root && scrollable(root)
}

if (window.top === window) {
  let active = false
  let dx = 0
  let timer = 0

  window.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || event.deltaMode !== 0) return
      if (!active) {
        const horizontal = Math.abs(event.deltaX) > 3 && Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.5
        if (!horizontal || canScrollHorizontally(event.target, event.deltaX)) return
        active = true
        dx = 0
      }
      dx += event.deltaX
      ipcRenderer.send(SWIPE_CHANNEL, 'update', dx)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        ipcRenderer.send(SWIPE_CHANNEL, 'end', dx)
        active = false
        dx = 0
      }, END_AFTER_MS)
    },
    { passive: true, capture: true }
  )
}
