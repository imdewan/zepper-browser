/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { webauthnShim } from './webauthn'

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
const WEBAUTHN_CHANNEL = 'zepper:webauthn'
const WEBAUTHN_CANCEL_CHANNEL = 'zepper:webauthn-cancel'

interface PageConfig {
  signInCompat: boolean
  hideChromium: boolean
  vendor: string
  blockWidevine: boolean
  askForWidevine: boolean
  globalPrivacyControl: boolean
  fingerprintSeed: number | null
  brand: { name: string; major: string; full: string } | null
  passkeys: boolean
  blockedPermissions: string[]
}

/**
 * Runs in the page's main world when presenting as Chrome or Edge: the page sees that browser, not
 * Electron. navigator.userAgentData names it (brands, toJSON, high-entropy values, matching the
 * request headers), and window.chrome has what Chrome's has (loadTimes, csi, app; Electron leaves it
 * empty, which bot checks read as an automated browser). Blank frames a script makes never run
 * Zepper's page script, so they're patched the moment the page reaches into one; patched functions
 * are Proxies of the originals, so they still look native.
 */
function chromeIdentityShim(name: string, major: string, full: string): void {
  type Brand = { brand: string; version: string }
  type Realm = Window & {
    NavigatorUAData?: { prototype: object }
    HTMLIFrameElement: typeof HTMLIFrameElement
    chrome?: Record<string, unknown>
  }
  const patched = new WeakSet<object>()
  const withBrand = (list: unknown, version: string): unknown =>
    Array.isArray(list) && !list.some((b: Brand) => b.brand === name) ? [{ brand: name, version }, ...list] : list
  const wrap = <T extends object>(target: T, apply: (call: () => unknown) => unknown): T =>
    new Proxy(target, { apply: (fn, self, args) => apply(() => Reflect.apply(fn as (...a: unknown[]) => unknown, self, args)) })

  const patch = (realm: Realm): void => {
    if (patched.has(realm)) return
    patched.add(realm)
    const proto = realm.NavigatorUAData?.prototype
    if (proto) {
      const brands = Object.getOwnPropertyDescriptor(proto, 'brands')
      if (brands?.get) Object.defineProperty(proto, 'brands', { ...brands, get: wrap(brands.get, (call) => withBrand(call(), major)) })
      const high = Object.getOwnPropertyDescriptor(proto, 'getHighEntropyValues')
      if (typeof high?.value === 'function') {
        Object.defineProperty(proto, 'getHighEntropyValues', {
          ...high,
          value: wrap(high.value as object, (call) =>
            (call() as Promise<Record<string, unknown>>).then((values) => ({
              ...values,
              brands: withBrand(values.brands, major),
              fullVersionList: withBrand(values.fullVersionList, full)
            }))
          )
        })
      }
      const json = Object.getOwnPropertyDescriptor(proto, 'toJSON')
      if (typeof json?.value === 'function') {
        Object.defineProperty(proto, 'toJSON', {
          ...json,
          value: wrap(json.value as object, (call) => {
            const value = call() as Record<string, unknown> | null
            return value && typeof value === 'object' ? { ...value, brands: withBrand(value.brands, major) } : value
          })
        })
      }
    }

    const native = <T extends (...args: never[]) => unknown>(fnName: string, fn: T): T => {
      Object.defineProperty(fn, 'name', { value: fnName })
      Object.defineProperty(fn, 'toString', { value: () => `function ${fnName}() { [native code] }` })
      return fn
    }
    const origin = realm.performance.timeOrigin / 1000
    const chrome = realm.chrome ?? {}
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
    chrome.csi ??= native('csi', () => ({ startE: origin * 1000, onloadT: origin * 1000 + 300, pageT: realm.performance.now(), tran: 15 }))
    chrome.app ??= {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: native('getDetails', () => null),
      getIsInstalled: native('getIsInstalled', () => false),
      runningState: native('runningState', () => 'cannot_run')
    }
    if (!realm.chrome) Object.defineProperty(realm, 'chrome', { value: chrome, configurable: true, writable: true })

    // Blank frames made in this realm get the same, as soon as the page reaches into one.
    const reach = (frame: unknown): void => {
      try {
        const child = frame as Realm | null
        if (child && child.location.href === 'about:blank') patch(child)
      } catch {
        // Another origin: its own page script patches it.
      }
    }
    const frameProto = realm.HTMLIFrameElement?.prototype
    for (const [key, windowOf] of [
      ['contentWindow', (v: unknown) => v],
      ['contentDocument', (v: unknown) => (v as Document | null)?.defaultView]
    ] as const) {
      const descriptor = frameProto && Object.getOwnPropertyDescriptor(frameProto, key)
      if (!descriptor?.get) continue
      Object.defineProperty(frameProto, key, {
        ...descriptor,
        get: wrap(descriptor.get, (call) => {
          const value = call()
          reach(windowOf(value))
          return value
        })
      })
    }
  }
  patch(window as Realm)
}

/**
 * Fingerprinting protection (runs in the page's world). Readouts fingerprinters rely on get
 * tiny, consistent noise: the same site sees the same values all session, another site (or the
 * next launch) sees different ones, so they can't be used to recognise you. Patched functions
 * are Proxies, so they still look native.
 */
function fingerprintShim(seed: number): void {
  let state = seed >>> 0 || 0x9e3779b9
  const random = (): number => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
  const bits = new Uint8Array(256).map(() => (random() < 0.5 ? 1 : 0))
  const MAX_PIXELS = 2048 * 2048
  const farble = (data: Uint8Array | Uint8ClampedArray): void => {
    if (data.length > MAX_PIXELS * 4) return
    for (let i = 0; i < data.length; i += 4) if (bits[(i >> 2) & 255]) data[i] ^= 1
  }
  // Each patched function's source still reads as the native one's (function toDataURL() { [native code] }).
  const originals = new WeakMap<object, object>()
  const disguise = <F extends object>(original: F, handler: ProxyHandler<F>): F => {
    const proxy = new Proxy(original, handler)
    originals.set(proxy, original)
    return proxy
  }
  const toStringDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, 'toString')!
  Object.defineProperty(Function.prototype, 'toString', {
    ...toStringDescriptor,
    value: disguise(toStringDescriptor.value as (...a: unknown[]) => string, {
      apply: (target, self, args) => Reflect.apply(target, originals.get(self as object) ?? self, args)
    })
  })
  const patch = <T extends object>(
    owner: T | undefined,
    key: string,
    apply: (target: (...a: unknown[]) => unknown, self: unknown, args: unknown[]) => unknown
  ): void => {
    if (!owner) return
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)
    if (!descriptor || typeof descriptor.value !== 'function') return
    Object.defineProperty(owner, key, { ...descriptor, value: disguise(descriptor.value, { apply }) })
  }

  // Canvas: readbacks (getImageData, toDataURL, toBlob) carry the noise.
  const getImageData = CanvasRenderingContext2D.prototype.getImageData
  patch(CanvasRenderingContext2D.prototype, 'getImageData', (target, self, args) => {
    const image = Reflect.apply(target, self, args) as ImageData
    farble(image.data)
    return image
  })
  const farbledCopy = (canvas: HTMLCanvasElement): HTMLCanvasElement | null => {
    try {
      if (!canvas.width || !canvas.height || canvas.width * canvas.height > MAX_PIXELS) return null
      const copy = document.createElement('canvas')
      copy.width = canvas.width
      copy.height = canvas.height
      const context = copy.getContext('2d')
      if (!context) return null
      context.drawImage(canvas, 0, 0)
      const image = getImageData.call(context, 0, 0, copy.width, copy.height)
      farble(image.data)
      context.putImageData(image, 0, 0)
      return copy
    } catch {
      return null
    }
  }
  for (const key of ['toDataURL', 'toBlob']) {
    patch(HTMLCanvasElement.prototype, key, (target, self, args) =>
      Reflect.apply(target, farbledCopy(self as HTMLCanvasElement) ?? self, args)
    )
  }

  // WebGL: pixels read back carry the noise too.
  for (const proto of [WebGLRenderingContext.prototype, globalThis.WebGL2RenderingContext?.prototype]) {
    patch(proto, 'readPixels', (target, self, args) => {
      const result = Reflect.apply(target, self, args)
      const pixels = args[6]
      if (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) farble(pixels)
      return result
    })
  }

  // Audio: offline renders (how audio fingerprints are taken) and analyser readouts.
  const offline = new WeakSet<AudioBuffer>()
  patch(globalThis.OfflineAudioContext?.prototype, 'startRendering', (target, self, args) =>
    (Reflect.apply(target, self, args) as Promise<AudioBuffer>).then((buffer) => {
      offline.add(buffer)
      return buffer
    })
  )
  const touched = new WeakMap<AudioBuffer, Set<number>>()
  patch(AudioBuffer.prototype, 'getChannelData', (target, self, args) => {
    const data = Reflect.apply(target, self, args) as Float32Array
    const buffer = self as AudioBuffer
    const channel = Number(args[0]) || 0
    if (offline.has(buffer) && !touched.get(buffer)?.has(channel)) {
      touched.set(buffer, (touched.get(buffer) ?? new Set()).add(channel))
      for (let i = 0; i < data.length; i++) data[i] += (bits[i & 255] ? 1 : -1) * 1e-7
    }
    return data
  })
  patch(AnalyserNode.prototype, 'getFloatFrequencyData', (target, self, args) => {
    const result = Reflect.apply(target, self, args)
    const data = args[0]
    if (data instanceof Float32Array) for (let i = 0; i < data.length; i++) data[i] += (bits[i & 255] ? 1 : -1) * 1e-4
    return result
  })

  // CPU cores: somewhere between 2 and the real count.
  const cores = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency')
  if (cores?.get) {
    const real = cores.get.call(navigator) as number
    const shown = Math.max(2, Math.min(real, 2 + Math.floor(random() * Math.max(1, real - 1))))
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { ...cores, get: disguise(cores.get, { apply: () => shown }) })
  }
}

/**
 * Permissions you haven't decided on read as "prompt" (runs in the page's world). Electron's
 * permission checks can only answer yes or no, so the page would see "denied" and sites that look
 * before they ask (Meet, Zoom, Teams…) would say they're blocked instead of asking. Notification.
 * permission likewise reads "default". Patched getters are Proxies, so they still look native.
 */
function permissionsShim(blocked: string[]): void {
  // Permissions API names → Zepper's site setting keys (those Zepper asks you about).
  const KEYS: Record<string, string> = {
    camera: 'camera',
    microphone: 'microphone',
    geolocation: 'geolocation',
    notifications: 'notifications',
    push: 'notifications',
    'clipboard-read': 'clipboard-read',
    midi: 'midi',
    'idle-detection': 'idle-detection',
    'window-management': 'window-management',
    'window-placement': 'window-management'
  }
  const undecided = (key: string | undefined): boolean => key !== undefined && !blocked.includes(key)
  const keyOf = new WeakMap<object, string>()

  const permissions = (globalThis as unknown as { Permissions?: { prototype: object } }).Permissions?.prototype
  const query = permissions && Object.getOwnPropertyDescriptor(permissions, 'query')
  if (permissions && typeof query?.value === 'function') {
    Object.defineProperty(permissions, 'query', {
      ...query,
      value: new Proxy(query.value as (descriptor: { name?: string; sysex?: boolean }) => Promise<object>, {
        apply(target, self, args: [{ name?: string; sysex?: boolean }]) {
          const descriptor = args[0]
          const key = descriptor?.name === 'midi' && descriptor.sysex ? 'midiSysex' : KEYS[String(descriptor?.name)]
          return Reflect.apply(target, self, args).then((status) => {
            if (key) keyOf.set(status, key)
            return status
          })
        }
      })
    })
  }

  const status = (globalThis as unknown as { PermissionStatus?: { prototype: object } }).PermissionStatus?.prototype
  const state = status && Object.getOwnPropertyDescriptor(status, 'state')
  if (status && state?.get) {
    Object.defineProperty(status, 'state', {
      ...state,
      get: new Proxy(state.get, {
        apply(target, self: object, args) {
          const value = Reflect.apply(target, self, args) as string
          return value === 'denied' && undecided(keyOf.get(self)) ? 'prompt' : value
        }
      })
    })
  }

  const notification = (globalThis as unknown as { Notification?: object }).Notification
  const permission = notification && Object.getOwnPropertyDescriptor(notification, 'permission')
  if (notification && permission?.get) {
    Object.defineProperty(notification, 'permission', {
      ...permission,
      get: new Proxy(permission.get, {
        apply(target, self, args) {
          const value = Reflect.apply(target, self, args) as string
          return value === 'denied' && undecided('notifications') ? 'default' : value
        }
      })
    })
  }
}

/** Global Privacy Control's JavaScript signal (runs in the page's world). */
function privacyControlShim(): void {
  Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true, enumerable: true })
}

/**
 * Which of the camera, microphone and screen the page is using (runs in the page's world), for the
 * tab's indicators. Tracks from getUserMedia and getDisplayMedia (and their clones) count while live;
 * stop() and "ended" end them. Changes go out as an event only our side knows the name of, sent
 * with references taken before the page's own scripts run, so a page can't hide its own use.
 */
function captureShim(eventName: string): void {
  type Kind = 'camera' | 'microphone' | 'screen'
  const dispatch = EventTarget.prototype.dispatchEvent
  const Custom = CustomEvent
  const doc = document
  const live = new Set<MediaStreamTrack>()
  const kinds = new WeakMap<MediaStreamTrack, Kind>()
  let last = ''
  const report = (): void => {
    const state = { camera: false, microphone: false, screen: false }
    for (const track of live) {
      if (track.readyState === 'live') state[kinds.get(track) ?? 'camera'] = true
      else live.delete(track)
    }
    const detail = JSON.stringify(state)
    if (detail === last) return
    last = detail
    dispatch.call(doc, new Custom(eventName, { detail }))
  }
  const watch = (track: MediaStreamTrack, kind: Kind): void => {
    kinds.set(track, kind)
    live.add(track)
    track.addEventListener('ended', report)
  }
  const proto = (globalThis as unknown as { MediaDevices?: { prototype: object } }).MediaDevices?.prototype
  const wrap = (name: 'getUserMedia' | 'getDisplayMedia', display: boolean): void => {
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, name)
    if (!proto || typeof descriptor?.value !== 'function') return
    Object.defineProperty(proto, name, {
      ...descriptor,
      value: new Proxy(descriptor.value as (...args: unknown[]) => Promise<MediaStream>, {
        apply(target, self, args) {
          return Reflect.apply(target, self, args).then((stream) => {
            for (const track of stream.getTracks()) watch(track, display ? 'screen' : track.kind === 'video' ? 'camera' : 'microphone')
            report()
            return stream
          })
        }
      })
    })
  }
  wrap('getUserMedia', false)
  wrap('getDisplayMedia', true)
  const track = MediaStreamTrack.prototype
  const stop = Object.getOwnPropertyDescriptor(track, 'stop')
  if (typeof stop?.value === 'function') {
    Object.defineProperty(track, 'stop', {
      ...stop,
      value: new Proxy(stop.value as () => void, {
        apply(target, self: MediaStreamTrack, args) {
          const result = Reflect.apply(target, self, args)
          if (live.has(self)) queueMicrotask(report)
          return result
        }
      })
    })
  }
  const clone = Object.getOwnPropertyDescriptor(track, 'clone')
  if (typeof clone?.value === 'function') {
    Object.defineProperty(track, 'clone', {
      ...clone,
      value: new Proxy(clone.value as () => MediaStreamTrack, {
        apply(target, self: MediaStreamTrack, args) {
          const copy = Reflect.apply(target, self, args) as MediaStreamTrack
          const kind = kinds.get(self)
          if (kind) watch(copy, kind)
          return copy
        }
      })
    })
  }
}

const CAPTURE_CHANNEL = 'zepper:capture'

/** window.open's name for a page's floating window (Zepper keeps it on top), and the key for "switching away". */
const DOCUMENT_PIP_FRAME = 'zepper-document-pip'
const ENTER_PIP_KEY = 'zepper.enterPictureInPicture'

/**
 * Document Picture-in-Picture (a call's floating window: Meet, Teams, Zoom) as Chrome does it (runs in
 * the page's world). Electron hands back a window it never shows; this opens a real one (a small
 * window Zepper keeps on top) and fires "enter" as Chrome would. It also remembers the page's
 * "enterpictureinpicture" handler, so Zepper can call it when you switch away from a call, as Chrome
 * does. Patched functions are Proxies, so they still look native.
 */
function documentPipShim(frameName: string, triggerKey: string): void {
  type Pip = EventTarget & { requestWindow?: unknown }
  const pip = (window as unknown as { documentPictureInPicture?: Pip }).documentPictureInPicture
  const proto = pip && (Object.getPrototypeOf(pip) as object)
  let current: Window | null = null
  if (proto) {
    const request = Object.getOwnPropertyDescriptor(proto, 'requestWindow')
    if (typeof request?.value === 'function') {
      Object.defineProperty(proto, 'requestWindow', {
        ...request,
        value: new Proxy(request.value as (options?: { width?: number; height?: number }) => Promise<Window>, {
          apply(_target, self: EventTarget, args: [{ width?: number; height?: number } | undefined]) {
            const options = args[0] ?? {}
            const width = Math.round(Math.min(Math.max(options.width ?? 400, 240), 1200))
            const height = Math.round(Math.min(Math.max(options.height ?? 300, 160), 900))
            if (current && !current.closed) current.close()
            const opened = window.open('', frameName, `popup,width=${width},height=${height}`)
            if (!opened) return Promise.reject(new DOMException('Picture-in-picture isn’t allowed now.', 'NotAllowedError'))
            current = opened
            opened.addEventListener('pagehide', () => {
              if (current === opened) current = null
            })
            const event = new Event('enter')
            Object.defineProperty(event, 'window', { value: opened })
            self.dispatchEvent(event)
            return Promise.resolve(opened)
          }
        })
      })
    }
    const property = Object.getOwnPropertyDescriptor(proto, 'window')
    if (property?.get) {
      Object.defineProperty(proto, 'window', {
        ...property,
        get: new Proxy(property.get, { apply: () => (current && !current.closed ? current : null) })
      })
    }
  }
  const sessionProto = navigator.mediaSession && (Object.getPrototypeOf(navigator.mediaSession) as object)
  const setHandler = sessionProto && Object.getOwnPropertyDescriptor(sessionProto, 'setActionHandler')
  let enter: ((details: { action: string }) => void) | null = null
  if (sessionProto && typeof setHandler?.value === 'function') {
    Object.defineProperty(sessionProto, 'setActionHandler', {
      ...setHandler,
      value: new Proxy(setHandler.value as (action: string, handler: unknown) => void, {
        apply(target, self, args: [string, unknown]) {
          if (args[0] === 'enterpictureinpicture') enter = typeof args[1] === 'function' ? (args[1] as typeof enter) : null
          return Reflect.apply(target, self, args)
        }
      })
    })
  }
  Object.defineProperty(window, Symbol.for(triggerKey), {
    value: () => {
      if (!enter) return false
      enter({ action: 'enterpictureinpicture' })
      return true
    }
  })
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
/** Runs in the page's main world on Google's sign-in page (after chromeIdentityShim): passkeys hidden when they can't work. */
function signInPageShim(keepPasskeys: boolean): void {
  const w = window as unknown as { PublicKeyCredential?: unknown }
  // Without the system's passkeys, Google would offer one that can't work; hide them.
  if (!keepPasskeys) delete w.PublicKeyCredential
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

/**
 * The Chrome Web Store works in Zepper (extensions install with "Add to Zepper"), but it still
 * shows its "Switch to Chrome" banner and prompt: they're hidden there.
 */
function hideSwitchToChrome(): void {
  const hide = (): void => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!/Switch to Chrome/.test(node.nodeValue ?? '')) continue
      // The prompt is a dialog of its own; the banner is the block holding nothing but its message
      const message = (node.nodeValue ?? '').trim()
      let block: HTMLElement | null = node.parentElement?.closest<HTMLElement>('[role="dialog"]') ?? null
      if (!block) {
        block = node.parentElement
        // (with its own button, "Install Zepper", but nothing more)
        const onlyMessage = (el: HTMLElement): boolean => el.innerText.replace(message, '').trim().length <= 24
        while (block?.parentElement && block.parentElement !== document.body && onlyMessage(block.parentElement)) {
          block = block.parentElement
        }
      }
      if (block && block.style.display !== 'none') block.style.setProperty('display', 'none', 'important')
    }
  }
  let queued = false
  const schedule = (): void => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      hide()
    })
  }
  document.addEventListener('DOMContentLoaded', () => {
    hide()
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
}

function applyCompat(): void {
  // Web pages, and the blank and srcdoc frames they make (which share their origin, and are where
  // fingerprinters look for an unpatched browser).
  if (!/^https?:/.test(location.href) && !(window !== window.top && /^about:(blank|srcdoc)$/.test(location.href))) return
  if (location.hostname === 'chromewebstore.google.com') hideSwitchToChrome()
  try {
    const config = ipcRenderer.sendSync(PAGE_CONFIG_CHANNEL) as PageConfig
    contextBridge.executeInMainWorld({ func: permissionsShim, args: [config.blockedPermissions ?? []] })
    // Camera, microphone and screen use, for the tab's indicators (the event name is this page's secret).
    const captureEvent = `zepper-capture-${crypto.randomUUID()}`
    document.addEventListener(captureEvent, (event) => ipcRenderer.send(CAPTURE_CHANNEL, String((event as CustomEvent).detail)))
    contextBridge.executeInMainWorld({ func: captureShim, args: [captureEvent] })
    if (window === window.top) contextBridge.executeInMainWorld({ func: documentPipShim, args: [DOCUMENT_PIP_FRAME, ENTER_PIP_KEY] })
    if (config.hideChromium) contextBridge.executeInMainWorld({ func: hideChromiumShim, args: [config.vendor] })
    if (config.globalPrivacyControl) contextBridge.executeInMainWorld({ func: privacyControlShim })
    if (config.brand)
      contextBridge.executeInMainWorld({ func: chromeIdentityShim, args: [config.brand.name, config.brand.major, config.brand.full] })
    if (config.fingerprintSeed !== null) contextBridge.executeInMainWorld({ func: fingerprintShim, args: [config.fingerprintSeed] })
    if (config.signInCompat && location.hostname === 'accounts.google.com')
      contextBridge.executeInMainWorld({ func: signInPageShim, args: [config.passkeys] })
    if (config.passkeys) {
      contextBridge.executeInMainWorld({
        func: webauthnShim,
        args: [
          (kind: string, options: string) => ipcRenderer.invoke(WEBAUTHN_CHANNEL, kind, options) as Promise<string>,
          () => ipcRenderer.send(WEBAUTHN_CANCEL_CHANNEL)
        ]
      })
    }
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
  // Printing goes through Zepper too, so the page waiting on the print dialog isn't mistaken for a hang.
  define('print', () => {
    open('print', '', '')
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

/**
 * Asks for generic hiding rules matching the classes, ids and links on the page, as it changes: the
 * whole page once it has loaded, then only what each change adds or alters, in idle time.
 */
function watchDomForGenericRules(): void {
  const seen = { classes: new Set<string>(), ids: new Set<string>(), hrefs: new Set<string>() }
  // A page churning out new names can't make this unbounded: past this, it stops watching.
  const PAGE_CAP = 50_000
  const PER_FLUSH = 2000
  const pending = new Set<Element>()
  let scheduled = false
  let observer: MutationObserver | null = null
  const full = (): boolean => seen.classes.size + seen.ids.size + seen.hrefs.size > PAGE_CAP

  const note = (el: Element, fresh: { classes: string[]; ids: string[]; hrefs: string[] }): void => {
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

  const flush = async (): Promise<void> => {
    scheduled = false
    const fresh = { classes: [] as string[], ids: [] as string[], hrefs: [] as string[] }
    let checked = 0
    for (const el of pending) {
      pending.delete(el)
      note(el, fresh)
      if (++checked >= PER_FLUSH) break
    }
    // More left over (a big change): the rest next time round.
    if (pending.size > 0) schedule()
    if (full()) {
      observer?.disconnect()
      pending.clear()
    }
    if (fresh.classes.length + fresh.ids.length + fresh.hrefs.length === 0) return
    try {
      const response = (await ipcRenderer.invoke(COSMETICS_DOM_CHANNEL, { url: location.href, ...fresh })) as CosmeticsResponse
      if (response.styles) webFrame.insertCSS(response.styles, { cssOrigin: 'user' })
    } catch {
      // Ignore: the page just keeps the rules it already has.
    }
  }

  function schedule(): void {
    if (scheduled) return
    scheduled = true
    // When the page is idle, but within a second.
    const run = (): void => void flush()
    window.requestIdleCallback(run, { timeout: 1000 })
  }

  const add = (root: Element): void => {
    if (root.matches('[class],[id],a[href]')) pending.add(root)
    for (const el of root.querySelectorAll('[class],[id],a[href]')) pending.add(el)
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (document.documentElement) add(document.documentElement)
    schedule()
    observer = new MutationObserver((records) => {
      if (full()) return
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.target instanceof Element) pending.add(record.target)
        } else {
          for (const node of record.addedNodes) if (node instanceof Element) add(node)
        }
      }
      if (pending.size > 0) schedule()
    })
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'] })
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

// ---------------------------------------------------------------------------
// Passwords: Zepper offers saved logins under sign-in fields, fills them, and offers to save new
// ones. The passwords themselves never pass through the page's own scripts: this runs in the
// preload's isolated world, and fills fields directly.

const PASSWORDS_CHANNEL = 'zepper:passwords'
const PASSWORDS_FILL_CHANNEL = 'zepper:passwords-fill'
const PASSWORDS_OPEN_CHANNEL = 'zepper:passwords-open'

type CredentialField = 'username' | 'password' | 'new-password'

/** Shown on the page (laid out, not hidden). */
const visible = (input: HTMLInputElement): boolean => input.getClientRects().length > 0 && getComputedStyle(input).visibility !== 'hidden'

/** Where a field's form-mates are: its form, or the document (or web component) it's in. */
const scopeOf = (input: HTMLInputElement): ParentNode => input.form ?? (input.getRootNode() as Document | ShadowRoot)

/** The element an event really happened on, inside web components too. */
const realTarget = (event: Event): EventTarget | null => event.composedPath()[0] ?? event.target

/** The password fields in a form (or the page), as you'd see them. */
function passwordFields(scope: ParentNode): HTMLInputElement[] {
  return [...scope.querySelectorAll<HTMLInputElement>('input[type="password"]')].filter(visible)
}

/** A field for choosing a password (sign-up or change), where Zepper suggests a strong one. */
function isNewPassword(input: HTMLInputElement): boolean {
  const autocomplete = input.autocomplete.toLowerCase()
  if (autocomplete.includes('new-password')) return true
  if (autocomplete.includes('current-password')) return false
  const hint = `${input.name} ${input.id} ${input.placeholder} ${input.getAttribute('aria-label') ?? ''}`.toLowerCase()
  if (/new|confirm|create|repeat|retype|verify|choose/.test(hint)) return true
  // Sign-up forms ask for the password twice.
  return passwordFields(scopeOf(input)).length >= 2
}

function credentialField(target: EventTarget | null): [HTMLInputElement, CredentialField] | null {
  if (!(target instanceof HTMLInputElement) || target.disabled || target.readOnly) return null
  if (target.type === 'password') return [target, isNewPassword(target) ? 'new-password' : 'password']
  if (!['text', 'email', 'tel', ''].includes(target.type)) return null
  const hint =
    `${target.autocomplete} ${target.name} ${target.id} ${target.getAttribute('aria-label') ?? ''} ${target.placeholder}`.toLowerCase()
  if (/search|newsletter|subscribe|coupon|promo/.test(hint)) return null
  // A username field: marked as one, an email field (sign-in pages that ask for the email first), named like
  // one, or the text field just before a password field.
  if (/username|webauthn/.test(target.autocomplete.toLowerCase())) return [target, 'username']
  if (target.type === 'email' || target.inputMode === 'email') return [target, 'username']
  if (/username|email|e-mail|login|user|account|phone/.test(hint)) return [target, 'username']
  return passwordAfter(target) ? [target, 'username'] : null
}

/** The password field belonging with a username field (same form, or the next password input on the page). */
function passwordAfter(input: HTMLInputElement): HTMLInputElement | null {
  const scope: ParentNode = scopeOf(input)
  const fields = [...scope.querySelectorAll<HTMLInputElement>('input')]
  const after = fields.slice(fields.indexOf(input) + 1)
  return after.find((f) => f.type === 'password' && visible(f)) ?? null
}

/** The username field belonging with a password field. */
function usernameBefore(input: HTMLInputElement): HTMLInputElement | null {
  const scope: ParentNode = scopeOf(input)
  const fields = [...scope.querySelectorAll<HTMLInputElement>('input')].filter(visible)
  const before = fields.slice(0, fields.indexOf(input)).reverse()
  return before.find((f) => ['text', 'email', 'tel', ''].includes(f.type)) ?? null
}

/** Sets a field's value so the page's own code (React and friends) notices. */
function setFieldValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  input.focus()
  if (setter) setter.call(input, value)
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function watchCredentials(): void {
  if (!/^https:|^http:\/\/(localhost|127\.0\.0\.1)/.test(location.href)) return
  let focused: [HTMLInputElement, CredentialField] | null = null
  // Filling moves focus between the fields; that isn't you asking for the list again.
  let filling = false
  // In an iframe, where the frame sits on screen comes from the last pointer event (Zepper places the list
  // with it); the top page's position is known already.
  const inFrame = window.top !== window
  let pointer: [number, number, number, number] | null = null
  if (inFrame) {
    const track = (event: MouseEvent): void => {
      pointer = [event.screenX, event.screenY, event.clientX, event.clientY]
    }
    document.addEventListener('mousemove', track, { capture: true, passive: true })
    document.addEventListener('mousedown', track, { capture: true, passive: true })
  }

  const report = (type: 'focus' | 'blur', field?: [HTMLInputElement, CredentialField]): void => {
    if (filling && type === 'focus') return
    const box = field?.[0].getBoundingClientRect()
    ipcRenderer.send(PASSWORDS_CHANNEL, {
      type,
      field: field?.[1],
      rect: box ? [box.left, box.top, box.width, box.height] : null,
      pointer: inFrame ? pointer : null
    })
  }

  document.addEventListener(
    'focusin',
    (event) => {
      const field = credentialField(realTarget(event))
      if (!field) return
      focused = field
      report('focus', field)
    },
    true
  )
  document.addEventListener(
    'focusout',
    (event) => {
      if (focused && realTarget(event) === focused[0] && !filling) report('blur')
    },
    true
  )

  // While the dropdown is open, the field keeps the keyboard and passes the list keys on.
  let dropdownOpen = false
  // Return picks a login only once you've moved into the list; otherwise it submits the form as usual.
  let inList = false
  ipcRenderer.on(PASSWORDS_OPEN_CHANNEL, (_event, open: boolean) => {
    dropdownOpen = open
    inList = false
  })
  document.addEventListener(
    'keydown',
    (event) => {
      if (!dropdownOpen || !focused || realTarget(event) !== focused[0]) return
      if (event.key === 'Escape') {
        dropdownOpen = false
        report('blur')
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || (event.key === 'Enter' && inList)) {
        inList = event.key !== 'Enter'
        event.preventDefault()
        event.stopImmediatePropagation()
        ipcRenderer.send(PASSWORDS_CHANNEL, { type: 'key', key: event.key })
      }
    },
    true
  )

  // The list doesn't follow the page as it scrolls; it closes, and clicking the field brings it back.
  document.addEventListener(
    'scroll',
    () => {
      if (!dropdownOpen) return
      dropdownOpen = false
      report('blur')
    },
    { capture: true, passive: true }
  )
  document.addEventListener(
    'mousedown',
    (event) => {
      if (!dropdownOpen && focused && realTarget(event) === focused[0]) report('focus', focused)
    },
    true
  )

  // Filling: Zepper sends the chosen login back.
  ipcRenderer.on(PASSWORDS_FILL_CHANNEL, (_event, login: { username?: string; password: string; allPasswords?: boolean }) => {
    if (!focused) return
    const [input, kind] = focused
    filling = true
    try {
      if (login.allPasswords) {
        // A suggested password goes in every new-password field of the form (the password and its confirmation).
        for (const field of passwordFields(scopeOf(input))) {
          if (!field.autocomplete.toLowerCase().includes('current-password')) setFieldValue(field, login.password)
        }
        setFieldValue(input, login.password)
        return
      }
      const user = kind === 'username' ? input : usernameBefore(input)
      const pass = kind === 'username' ? passwordAfter(input) : input
      if (user && login.username) setFieldValue(user, login.username)
      if (pass && login.password) setFieldValue(pass, login.password)
    } finally {
      // Focus events from filling arrive after this returns.
      setTimeout(() => (filling = false), 100)
    }
  })

  // Saving: when a form with a typed password is submitted (or its button pressed), offer to save it.
  let offered = ''
  const capture = (scope: ParentNode): void => {
    const filled = [...scope.querySelectorAll<HTMLInputElement>('input[type="password"]')].filter((f) => f.value)
    // Sign-up and change-password forms: the new password (the last one), not the current one.
    const pass = filled.find((f) => f.autocomplete.toLowerCase().includes('new-password')) ?? filled[filled.length - 1]
    if (!pass) return
    const named = [...scope.querySelectorAll<HTMLInputElement>('input')].find(
      (f) => visible(f) && f.value && (/username|email/.test(f.autocomplete.toLowerCase()) || f.type === 'email')
    )
    const user = named ?? usernameBefore(filled[0])
    const key = `${user?.value ?? ''}\u0000${pass.value}`
    if (key === offered) return
    offered = key
    ipcRenderer.send(PASSWORDS_CHANNEL, { type: 'submit', username: user?.value ?? '', password: pass.value })
  }
  document.addEventListener('submit', (event) => event.target instanceof HTMLFormElement && capture(event.target), true)
  document.addEventListener(
    'click',
    (event) => {
      const button = (event.target as Element | null)?.closest?.('button, input[type="submit"], [role="button"]')
      if (button) capture((button as HTMLElement).closest('form') ?? document)
    },
    true
  )
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type === 'password') {
        capture(event.target.form ?? document)
      }
    },
    true
  )
}

watchCredentials()
