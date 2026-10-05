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
 * 3. Site compatibility (see main/compat.ts): hides Chromium-only APIs when
 *    presenting as Firefox or Safari, and the Google sign-in fix.
 */

const COSMETICS_CHANNEL = 'zepper:cosmetics'
const COSMETICS_DOM_CHANNEL = 'zepper:cosmetics-dom'
const SWIPE_CHANNEL = 'zepper:swipe'
const PAGE_CONFIG_CHANNEL = 'zepper:page-config'

interface PageConfig {
  signInCompat: boolean
  hideChromium: boolean
  vendor: string
  blockWidevine: boolean
  askForWidevine: boolean
  globalPrivacyControl: boolean
}

/** Global Privacy Control's JavaScript signal (runs in the page's world). */
function privacyControlShim(): void {
  Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true, enumerable: true })
}

const DRM_NEEDED_CHANNEL = 'zepper:drm-needed'
/** Fired on the document (shared by the page's world and ours) when the page asks for Widevine. */
const DRM_NEEDED_EVENT = 'zepper-drm-needed'

interface CosmeticsResponse {
  styles: string
  scripts: string[]
}

// ---- Site compatibility -----------------------------------------------------------

/** Runs in the page's main world when presenting as Firefox or Safari: no Chromium-only APIs. */
function hideChromiumShim(vendor: string): void {
  const value = (target: object, prop: string, v: unknown): void => {
    try {
      Object.defineProperty(target, prop, { get: () => v, configurable: true })
    } catch {
      // Some properties can't be redefined; leave them.
    }
  }
  value(Navigator.prototype, 'userAgentData', undefined)
  value(Navigator.prototype, 'vendor', vendor)
  delete (window as unknown as { chrome?: unknown }).chrome
}

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

/**
 * Runs in the page's main world while Widevine is off: requests for it fail
 * the way they would in a browser without it, and we hear about them.
 */
function widevineShim(eventName: string): void {
  const original = Navigator.prototype.requestMediaKeySystemAccess
  if (!original) return
  const wrapped = function (this: Navigator, keySystem: string, configs: MediaKeySystemConfiguration[]): Promise<MediaKeySystemAccess> {
    if (typeof keySystem === 'string' && keySystem.toLowerCase().includes('widevine')) {
      document.dispatchEvent(new CustomEvent(eventName))
      return Promise.reject(new DOMException('Unsupported keySystem or supportedConfigurations.', 'NotSupportedError'))
    }
    return original.call(this, keySystem, configs)
  }
  Object.defineProperty(wrapped, 'name', { value: 'requestMediaKeySystemAccess' })
  Object.defineProperty(wrapped, 'toString', { value: () => 'function requestMediaKeySystemAccess() { [native code] }' })
  Navigator.prototype.requestMediaKeySystemAccess = wrapped
}

/**
 * Tells the browser a page needs Widevine, once per page. Sites like YouTube
 * probe for it while playing ordinary video, so if something starts playing
 * shortly after, it wasn't really needed.
 */
function reportWidevineNeeds(): void {
  let reported = false
  document.addEventListener(DRM_NEEDED_EVENT, () => {
    if (reported) return
    reported = true
    window.setTimeout(() => {
      const playing = Array.from(document.querySelectorAll('video')).some((v) => !v.paused && v.currentTime > 0)
      if (!playing) ipcRenderer.send(DRM_NEEDED_CHANNEL, location.hostname)
    }, 2000)
  })
}

function applyCompat(): void {
  if (!/^https?:/.test(location.href)) return
  try {
    const config = ipcRenderer.sendSync(PAGE_CONFIG_CHANNEL) as PageConfig
    if (config.hideChromium) contextBridge.executeInMainWorld({ func: hideChromiumShim, args: [config.vendor] })
    if (config.globalPrivacyControl) contextBridge.executeInMainWorld({ func: privacyControlShim })
    if (config.signInCompat && location.hostname === 'accounts.google.com') contextBridge.executeInMainWorld({ func: signInPageShim })
    if (config.blockWidevine) {
      contextBridge.executeInMainWorld({ func: widevineShim, args: [DRM_NEEDED_EVENT] })
      if (config.askForWidevine) reportWidevineNeeds()
    }
  } catch {
    // Never break a page over this.
  }
}

// ---- JavaScript dialogs ------------------------------------------------------------
//
// alert(), confirm() and prompt() open Zepper's own dialog (labelled with the
// site, with spam protection) instead of Electron's: a plain system box for
// the first two, and nothing at all for prompt(), which Electron doesn't
// support. Like the real ones, they block the page until answered.

const DIALOG_CHANNEL = 'zepper:dialog'

/** Runs in the page's main world. `open` crosses back into this preload and waits for the answer. */
function dialogShim(open: (kind: string, message: string, value: string) => unknown): void {
  const define = (name: string, fn: (...args: never[]) => unknown): void => {
    Object.defineProperty(fn, 'name', { value: name })
    Object.defineProperty(fn, 'toString', { value: () => `function ${name}() { [native code] }` })
    Object.defineProperty(window, name, { value: fn, writable: true, configurable: true, enumerable: true })
  }
  const text = (value: unknown): string => (value === undefined ? '' : String(value))
  define('alert', (message?: unknown) => {
    open('alert', text(message), '')
  })
  define('confirm', (message?: unknown) => open('confirm', text(message), '') === true)
  define('prompt', (message?: unknown, value?: unknown) => {
    const result = open('prompt', text(message), text(value))
    return typeof result === 'string' ? result : null
  })
}

function applyDialogs(): void {
  try {
    contextBridge.executeInMainWorld({
      func: dialogShim,
      args: [(kind: string, message: string, value: string) => ipcRenderer.sendSync(DIALOG_CHANNEL, kind, message, value)]
    })
  } catch {
    // Fall back to Electron's own dialogs.
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
    // A page churning out new names can't make this unbounded: a cap per flush and per page.
    if (seen.classes.size + seen.ids.size + seen.hrefs.size > 50_000) return fresh
    const elements = root.querySelectorAll('[class],[id],a[href]')
    for (let i = 0; i < elements.length && i < 4000 && fresh.classes.length + fresh.ids.length + fresh.hrefs.length < 2000; i++) {
      const el = elements[i]
      for (const name of el.classList) {
        if (fresh.classes.length >= 2000) break
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
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'id']
    })
  })
}

applyCompat()
applyDialogs()
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
//
// A trackpad swipe arrives as a stream of wheel events: finger movement, then
// (after the fingers lift) momentum that decays smoothly. Each stream is
// classified once, from its first few events: vertical scrolling, scrolling
// something horizontally, or a swipe. Only a swipe is reported, and only its
// finger phase; momentum never pushes a swipe over the line, and the browser
// ignores the momentum tail that lands on the next page.

/** A pause this long ends a wheel stream. */
const QUIET_MS = 160
/** Horizontal travel needed before a stream is classified. */
const DECIDE_PX = 8
/** Consecutive smoothly shrinking deltas that mean the fingers have lifted. */
const MOMENTUM_STEPS = 4

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

function watchSwipes(): void {
  let mode: 'idle' | 'pending' | 'swipe' | 'ignore' = 'idle'
  let target: EventTarget | null = null
  let dx = 0
  let dy = 0
  let lastDelta = 0
  let shrinking = 0
  let dxBeforeShrink = 0
  let peak = 0
  let released = false
  let quietTimer = 0

  const send = (phase: 'update' | 'end', distance: number): void => ipcRenderer.send(SWIPE_CHANNEL, phase, distance, peak)
  const reset = (): void => {
    mode = 'idle'
    dx = dy = lastDelta = shrinking = dxBeforeShrink = peak = 0
    released = false
  }
  const finish = (): void => {
    if (mode === 'swipe' && !released) send('end', dx)
    reset()
  }

  window.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || event.deltaMode !== 0) return
      window.clearTimeout(quietTimer)
      quietTimer = window.setTimeout(finish, QUIET_MS)
      if (mode === 'ignore') return

      if (mode === 'idle') {
        mode = 'pending'
        target = event.target
      }
      if (mode === 'pending') {
        dx += event.deltaX
        dy += event.deltaY
        const ax = Math.abs(dx)
        const ay = Math.abs(dy)
        if (ay > 6 && ay >= ax * 0.8)
          mode = 'ignore' // Scrolling vertically.
        else if (ax < DECIDE_PX) return
        else if (ax < ay * 2 || canScrollHorizontally(target, dx)) mode = 'ignore'
        else {
          mode = 'swipe'
          lastDelta = Math.abs(event.deltaX)
          peak = lastDelta
          send('update', dx)
        }
        return
      }

      // Swiping. Once momentum starts, the decision is made; the rest is ignored.
      if (released) return
      const delta = Math.abs(event.deltaX)
      if (delta > 0 && delta < lastDelta && delta >= lastDelta * 0.5) {
        if (shrinking === 0) dxBeforeShrink = dx
        shrinking++
      } else if (delta !== lastDelta) {
        shrinking = 0 // Repeated values (common in momentum) neither count nor reset.
      }
      lastDelta = delta
      dx += event.deltaX
      if (shrinking === 0) peak = Math.max(peak, delta)
      if (shrinking >= MOMENTUM_STEPS) {
        released = true
        send('end', dxBeforeShrink)
        return
      }
      send('update', dx)
    },
    { passive: true, capture: true }
  )

  // Pages that handle horizontal wheel themselves (maps, sliders, editors) win.
  window.addEventListener(
    'wheel',
    (event) => {
      if (!event.defaultPrevented || mode === 'idle' || mode === 'ignore') return
      if (mode === 'swipe' && !released) send('end', 0)
      mode = 'ignore'
    },
    { passive: true }
  )
}

watchSwipes()
