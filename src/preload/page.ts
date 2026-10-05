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
 * 3. Google sign-in compatibility (accounts.google.com only), see main/compat.ts.
 */

const COSMETICS_CHANNEL = 'zepper:cosmetics'
const COSMETICS_DOM_CHANNEL = 'zepper:cosmetics-dom'
const SWIPE_CHANNEL = 'zepper:swipe'
const SIGN_IN_COMPAT_CHANNEL = 'zepper:sign-in-compat'

interface CosmeticsResponse {
  styles: string
  scripts: string[]
}

// ---- Google sign-in compatibility ----------------------------------------------

/** Runs in the page's main world: makes `window.chrome` look like real Chrome's and hides passkeys. */
function signInPageShim(): void {
  const native = <T extends (...args: never[]) => unknown>(name: string, fn: T): T => {
    const source = `function ${name}() { [native code] }`
    Object.defineProperty(fn, 'name', { value: name })
    Object.defineProperty(fn, 'toString', { value: () => source })
    return fn
  }
  const origin = performance.timeOrigin / 1000
  const w = window as unknown as { chrome?: Record<string, unknown>; PublicKeyCredential?: unknown }
  const chrome = w.chrome ?? {}
  chrome.app ??= {
    isInstalled: false,
    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    getDetails: native('getDetails', () => null),
    getIsInstalled: native('getIsInstalled', () => false),
    runningState: native('runningState', () => 'cannot_run')
  }
  chrome.csi ??= native('csi', () => ({ startE: origin * 1000, onloadT: origin * 1000 + 300, pageT: performance.now(), tran: 15 }))
  chrome.loadTimes ??= native('loadTimes', () => ({
    requestTime: origin,
    startLoadTime: origin,
    commitLoadTime: origin + 0.1,
    finishDocumentLoadTime: origin + 0.3,
    finishLoadTime: origin + 0.4,
    firstPaintTime: origin + 0.2,
    firstPaintAfterLoadTime: 0,
    navigationType: 'Other',
    wasFetchedViaSpdy: true,
    wasNpnNegotiated: true,
    npnNegotiatedProtocol: 'h2',
    wasAlternateProtocolAvailable: false,
    connectionInfo: 'h2'
  }))
  if (!w.chrome) Object.defineProperty(window, 'chrome', { value: chrome, configurable: true, writable: true })
  delete w.PublicKeyCredential
}

function applySignInCompat(): void {
  if (location.hostname !== 'accounts.google.com') return
  try {
    if (ipcRenderer.sendSync(SIGN_IN_COMPAT_CHANNEL) === true) contextBridge.executeInMainWorld({ func: signInPageShim })
  } catch {
    // Never break the sign-in page over this.
  }
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

applySignInCompat()
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
