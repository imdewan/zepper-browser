import { BrowserWindow, View, WebContentsView, screen, type Rectangle, type WebContents, type WebFrameMain } from 'electron'
import { IPC, type PipState } from '@shared/types'
import { FIND_IN_SHADOWS } from './page-media'

/** For a page script: the element above another as the page is drawn, through a slot or out of a shadow root. */
const UP = `const zepperUp = (el) => el.assignedSlot || el.parentElement || (el.parentNode && el.parentNode.host) || null`

/** For a page script: the frame's playing video, the largest, so a muted preview thumbnail never beats the main player. */
const PICK_VIDEO = `const zepperVideo = () => {
  const area = (v) => v.getBoundingClientRect().width * v.getBoundingClientRect().height
  return zepperFind('video')
    .filter((v) => !v.srcObject && !v.paused && !v.ended && v.readyState >= 2 && v.videoWidth >= 160)
    .sort((a, b) => area(b) - area(a))[0]
}`

/** How big a frame's playing video is on the page; null when it has none that can float. */
const FIND_SCRIPT = `(() => {
  ${FIND_IN_SHADOWS}
  ${PICK_VIDEO}
  const video = zepperVideo()
  if (!video) return null
  const box = video.getBoundingClientRect()
  return box.width * box.height
})()`

/** Run in a frame: where it is among its parent's frames (window.parent[i]), which works across sites. */
const FRAME_INDEX_SCRIPT = `(() => {
  const parent = window.parent
  for (let i = 0; i < parent.length; i++) if (parent[i] === window) return i
  return -1
})()`

/**
 * Makes the marked video, or the frame holding it, fill the (small) window. Everything else on the page
 * is hidden, and the ancestors lose anything that would trap a fixed element (transforms, filters,
 * containment). Author !important beats the player's inline styles.
 */
const PIP_CSS = `
html[data-zepper-pip-active] * { visibility: hidden !important; }
html[data-zepper-pip-active], html[data-zepper-pip-active] body {
  overflow: hidden !important; background: #000 !important;
}
[data-zepper-pip-ancestor] {
  transform: none !important; translate: none !important; scale: none !important; rotate: none !important;
  filter: none !important; backdrop-filter: none !important; perspective: none !important;
  contain: none !important; container-type: normal !important; will-change: auto !important;
  clip-path: none !important; mask: none !important;
}
:is(video, iframe, frame)[data-zepper-pip] {
  visibility: visible !important;
  position: fixed !important; inset: 0 !important;
  width: 100vw !important; height: 100vh !important;
  min-width: 0 !important; min-height: 0 !important;
  max-width: none !important; max-height: none !important;
  margin: 0 !important; padding: 0 !important; border: 0 !important; border-radius: 0 !important;
  transform: none !important; translate: none !important; scale: none !important; rotate: none !important;
  object-fit: contain !important; background: #000 !important;
  z-index: 2147483647 !important;
}
`

/**
 * Marks what fills the player in one frame: its playing video, or, in a frame above the video's, the
 * frame at `frameIndex` among its own, which holds the video. Its ancestors are marked too, out through
 * shadow roots, and each of those roots gets the player's styles (the document's don't reach into them),
 * as does the document of a frame other than the top one, which has no insertCSS. Returns the video's
 * size, or true for a frame; null when it isn't there.
 */
function markScript(frameIndex: number | null, styleDocument: boolean): string {
  return `(() => {
  ${FIND_IN_SHADOWS}
  ${UP}
  ${PICK_VIDEO}
  const index = ${JSON.stringify(frameIndex)}
  const target = index === null ? zepperVideo() : zepperFind('iframe, frame').find((f) => f.contentWindow === window[index])
  if (!target) return null
  const roots = new Set(${JSON.stringify(styleDocument)} ? [document] : [])
  target.setAttribute('data-zepper-pip', '')
  for (let el = target; el; el = zepperUp(el)) {
    if (el !== target) el.setAttribute('data-zepper-pip-ancestor', '')
    if (el.getRootNode() !== document) roots.add(el.getRootNode())
  }
  document.documentElement.setAttribute('data-zepper-pip-active', '')
  if (roots.size) {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(${JSON.stringify(PIP_CSS)})
    for (const root of roots) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
    window[Symbol.for('zepper.pip')] = { sheet, roots: [...roots] }
  }
  return index === null ? { width: target.videoWidth, height: target.videoHeight } : true
})()`
}

const UNMARK_SCRIPT = `(() => {
  ${FIND_IN_SHADOWS}
  zepperFind('[data-zepper-pip], [data-zepper-pip-ancestor]').forEach((el) => {
    el.removeAttribute('data-zepper-pip')
    el.removeAttribute('data-zepper-pip-ancestor')
  })
  document.documentElement.removeAttribute('data-zepper-pip-active')
  const key = Symbol.for('zepper.pip')
  const styled = window[key]
  if (styled) for (const root of styled.roots) root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== styled.sheet)
  delete window[key]
})()`

/** Whether the floating video has paused (run in its frame). */
const PAUSED_SCRIPT = `(() => {
  ${FIND_IN_SHADOWS}
  const video = zepperFind('video[data-zepper-pip]')[0]
  return !!video && video.paused
})()`

/**
 * Where the floating video is (run in its frame, a couple of times a second), for the controls. A page
 * that moves on to another video (the next Short, the next in a playlist) floats that one instead, and
 * the marks follow a video the page moves elsewhere in it.
 */
const STATE_SCRIPT = `(() => {
  ${FIND_IN_SHADOWS}
  ${UP}
  ${PICK_VIDEO}
  let video = zepperFind('video[data-zepper-pip]')[0]
  const playing = zepperVideo()
  if (playing && playing !== video && (!video || video.paused || !video.isConnected)) {
    if (video) video.removeAttribute('data-zepper-pip')
    playing.setAttribute('data-zepper-pip', '')
    video = playing
  }
  if (!video) return null
  for (let el = zepperUp(video); el; el = zepperUp(el)) el.setAttribute('data-zepper-pip-ancestor', '')
  const actions = window[Symbol.for('zepper.mediaActions')]
  return {
    time: video.currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : null,
    paused: video.paused,
    width: video.videoWidth,
    height: video.videoHeight,
    actions: actions ? actions() : null
  }
})()`

/** The page's previous and next track buttons (Media Session), in a frame; see mediaActionsShim in the page preload. */
const ACTIONS_SCRIPT = `(() => { const actions = window[Symbol.for('zepper.mediaActions')]; return actions ? actions() : null })()`

function trackScript(action: 'previoustrack' | 'nexttrack'): string {
  return `(() => { const actions = window[Symbol.for('zepper.mediaActions')]; return actions ? actions(${JSON.stringify(action)}) : false })()`
}

/** Plays or pauses the floating video (run in its frame); false when it isn't there. */
const TOGGLE_SCRIPT = `(() => {
  ${FIND_IN_SHADOWS}
  const video = zepperFind('video[data-zepper-pip]')[0]
  if (!video) return false
  if (video.paused) void video.play()
  else video.pause()
  return true
})()`

/** Moves the floating video to a time, in seconds (run in its frame); false when it isn't there. */
function seekToScript(time: number): string {
  return `(() => {
  ${FIND_IN_SHADOWS}
  const video = zepperFind('video[data-zepper-pip]')[0]
  if (!video || !Number.isFinite(video.duration)) return false
  video.currentTime = Math.max(0, Math.min(video.duration - 0.25, ${Number(time) || 0}))
  return true
})()`
}

/** Skips the floating video by some seconds (run in its frame); false when it isn't there. */
function seekScript(seconds: number): string {
  return `(() => {
  ${FIND_IN_SHADOWS}
  const video = zepperFind('video[data-zepper-pip]')[0]
  if (!video) return false
  const end = Number.isFinite(video.duration) ? video.duration - 0.25 : Infinity
  video.currentTime = Math.max(0, Math.min(end, video.currentTime + ${Number(seconds)}))
  return true
})()`
}

/** The frame with the largest playing video that can float: the page itself, or a frame in it (an embedded player). */
async function videoFrame(wc: WebContents): Promise<WebFrameMain | null> {
  const frames = wc.mainFrame.framesInSubtree
  // Cross-site or detached frames can refuse.
  const areas = await Promise.all(frames.map((frame) => frame.executeJavaScript(FIND_SCRIPT).catch(() => null)))
  let best: WebFrameMain | null = null
  let bestArea = -1
  areas.forEach((area, i) => {
    if (typeof area === 'number' && area > bestArea) [best, bestArea] = [frames[i], area]
  })
  return best
}

/** Marks the frame's video, then, in each frame above it, the frame it's in. Returns the video's size. */
async function markVideo(frame: WebFrameMain): Promise<{ width: number; height: number } | null> {
  const size = (await frame.executeJavaScript(markScript(null, !!frame.parent)).catch(() => null)) as {
    width: number
    height: number
  } | null
  if (!size) return null
  for (let child = frame, parent = frame.parent; parent; child = parent, parent = parent.parent) {
    const index = await child.executeJavaScript(FRAME_INDEX_SCRIPT).catch(() => -1)
    if (typeof index !== 'number' || index < 0) return null
    if (!(await parent.executeJavaScript(markScript(index, !!parent.parent)).catch(() => null))) return null
  }
  return size
}

/** Puts a page back as it was, in every frame. */
function unmark(wc: WebContents): void {
  if (wc.isDestroyed()) return
  for (const frame of wc.mainFrame.framesInSubtree) void frame.executeJavaScript(UNMARK_SCRIPT).catch(() => {})
}

/** The player's longest side at the size setting's share of the screen, within these. */
const MIN_LONG = 280
const MAX_LONG = 760
/** Smallest you can make it. */
const MIN_RESIZE_LONG = 220
const MIN_RESIZE_SHORT = 120
/** The player follows the video's shape, from tall (Shorts) to wide (cinema), within these. */
const MIN_ASPECT = 0.5
const MAX_ASPECT = 2.4
/** At most this share of the screen, as in Chromium. */
const MAX_SHARE = 0.8
const MARGIN = 20
const RADIUS = 14
/** How often the controls hear where the video is. */
const STATE_MS = 500
/** How often the player looks for the pointer over it. */
const POINTER_MS = 100
/** How long after the player closes its page is drawn at its own size again (see cleanup). */
const RESTORE_MS = 500

type Size = { width: number; height: number }

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))

/** The window's size for a video's shape, with its longest side `long`, within the screen. */
function sizeFor(aspect: number, long: number, area: Rectangle): Size {
  let width = aspect >= 1 ? long : long * aspect
  let height = aspect >= 1 ? long / aspect : long
  const fit = Math.min(1, (area.width * MAX_SHARE) / width, (area.height * MAX_SHARE) / height)
  width *= fit
  height *= fit
  return { width: Math.round(width), height: Math.round(height) }
}

function minimumFor(aspect: number): Size {
  if (aspect >= 1) {
    const width = Math.max(MIN_RESIZE_LONG, MIN_RESIZE_SHORT * aspect)
    return { width: Math.round(width), height: Math.round(width / aspect) }
  }
  const height = Math.max(MIN_RESIZE_LONG, MIN_RESIZE_SHORT / aspect)
  return { width: Math.round(height * aspect), height: Math.round(height) }
}

/**
 * The page keeps the size it had in its tab and is drawn smaller (Chromium's device emulation, as
 * DevTools' device mode does it), so it never sees a size change: a feed of Shorts, which works out
 * the current video from its layout, moved to another one when it was resized. This is where the page
 * view goes, and at what scale, for its video (filling the page, letterboxed) to fill the window.
 */
function fitPage(page: Size, video: Size, window: Size): { scale: number; bounds: Rectangle } {
  const aspect = video.width / video.height
  const shown =
    page.width / page.height > aspect
      ? { width: page.height * aspect, height: page.height }
      : { width: page.width, height: page.width / aspect }
  const scale = Math.min(window.width / shown.width, window.height / shown.height)
  const x = (window.width - shown.width * scale) / 2 - ((page.width - shown.width) / 2) * scale
  const y = (window.height - shown.height * scale) / 2 - ((page.height - shown.height) / 2) * scale
  return {
    scale,
    bounds: { x: Math.round(x), y: Math.round(y), width: Math.round(page.width * scale), height: Math.round(page.height * scale) }
  }
}

function emulation(page: Size, scale: number): Parameters<WebContents['enableDeviceEmulation']>[0] {
  return {
    screenPosition: 'desktop',
    screenSize: { width: 0, height: 0 },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: 0,
    viewSize: { width: page.width, height: page.height },
    scale
  }
}

interface RawState {
  time: number
  duration: number | null
  paused: boolean
  width: number
  height: number
  actions: { previous: boolean; next: boolean } | null
}

export interface PipHost {
  preload: string
  load(wc: WebContents, page: string): void
  /** Starting width as a share of the screen's width. */
  widthFraction(): number
  /** The page asked to go back to its tab. */
  onBack(tabId: string): void
  /** The player window was closed from outside (not via exit()). */
  onClosed(tabId: string): void
}

/**
 * Floating video player, laid out as Chromium's. The tab's own web view moves into a small frameless,
 * rounded, resizable, always-on-top window, drawn smaller with its playing video filling the window,
 * and the controls layered on top. Coming back to the tab moves the view back.
 */
export class PipPlayer {
  private win: BrowserWindow | null = null
  private controls: WebContentsView | null = null
  private tabId: string | null = null
  private view: WebContentsView | null = null
  /** The frame playing the video: the page's own, or an embedded player's. */
  private frame: WebFrameMain | null = null
  private cssKey: string | null = null
  /** The page's size in its tab, which it keeps here. */
  private page: Size | null = null
  /** The video's own size, for its shape. */
  private video: Size | null = null
  private layout: (() => void) | null = null
  /** Rounds the window's corners, around the page view. */
  private clip: View | null = null
  private stateTimer: ReturnType<typeof setInterval> | null = null
  private pointerTimer: ReturnType<typeof setInterval> | null = null
  /** Where the pointer was last time, and whether it was over the player. */
  private pointer: { x: number; y: number; inside: boolean } | null = null
  /** Pages that left the player a moment ago, still at their own size (see cleanup). */
  private readonly restoring = new Map<number, ReturnType<typeof setTimeout>>()
  /** Where the player was last left, and at which size setting, so a new video reopens there. */
  private lastBounds: { bounds: Rectangle; fraction: number } | null = null

  constructor(private readonly host: PipHost) {}

  get activeTabId(): string | null {
    return this.tabId
  }

  controlsWebContents(): WebContents | null {
    return this.controls && !this.controls.webContents.isDestroyed() ? this.controls.webContents : null
  }

  /**
   * Floats the tab's playing video, in the page or in a frame in it (an embedded player), inside web
   * components too. Returns false when there's none that can float here.
   */
  async enter(tabId: string, view: WebContentsView): Promise<boolean> {
    const wc = view.webContents
    const frame = await videoFrame(wc)
    if (!frame) return false
    if (this.tabId) this.exit()
    const video = await markVideo(frame)
    if (!video || !video.width || !video.height) {
      unmark(wc)
      return false
    }
    const { width, height } = view.getBounds()
    const page = { width: Math.max(1, width), height: Math.max(1, height) }
    clearTimeout(this.restoring.get(wc.id))
    this.restoring.delete(wc.id)
    // At its own size and scale first, before the view moves: nothing changes for the page yet.
    wc.enableDeviceEmulation(emulation(page, 1))

    const aspect = clamp(video.width / video.height, MIN_ASPECT, MAX_ASPECT)
    const bounds = this.initialBounds(aspect)
    const minimum = minimumFor(aspect)
    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      // A floating panel: stays above full-screen apps and on every desktop, and clicking it doesn't
      // activate Zepper. (setVisibleOnAllWorkspaces would instead hide the whole app for a moment.)
      type: 'panel',
      roundedCorners: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      // Transparent window + clipped views: the rounding never depends on how macOS treats frameless windows.
      transparent: true,
      show: false,
      minWidth: minimum.width,
      minHeight: minimum.height,
      backgroundColor: '#00000000',
      webPreferences: { preload: this.host.preload, sandbox: true, contextIsolation: true, partition: 'zepper-ui' }
    })
    win.setAspectRatio(aspect)
    win.setAlwaysOnTop(true, 'floating')

    // The page view is bigger than the window (only its video shows), so a rounded view around it clips it.
    const clip = new View()
    clip.setBorderRadius(RADIUS)
    clip.setBackgroundColor('#000000')
    win.contentView.addChildView(clip)
    clip.addChildView(view)
    const controls = new WebContentsView({
      webPreferences: { preload: this.host.preload, sandbox: true, contextIsolation: true, partition: 'zepper-ui' }
    })
    controls.setBackgroundColor('#00000000')
    controls.setBorderRadius(RADIUS)
    win.contentView.addChildView(controls)
    controls.webContents.on('will-navigate', (event) => event.preventDefault())
    this.host.load(controls.webContents, `pip.html?tab=${encodeURIComponent(tabId)}`)

    this.page = page
    this.video = video
    const layout = (): void => {
      if (wc.isDestroyed() || !this.video) return
      const [width, height] = win.getContentSize()
      const fit = fitPage(page, this.video, { width, height })
      wc.enableDeviceEmulation(emulation(page, fit.scale))
      clip.setBounds({ x: 0, y: 0, width, height })
      view.setBounds(fit.bounds)
      controls.setBounds({ x: 0, y: 0, width, height })
    }
    this.layout = layout
    this.clip = clip
    layout()
    win.on('resize', layout)
    win.on('closed', () => {
      if (this.win !== win) return
      const closedTab = this.tabId
      this.cleanup(false)
      if (closedTab) this.host.onClosed(closedTab)
    })

    this.cssKey = await wc.insertCSS(PIP_CSS).catch(() => null)
    this.win = win
    this.controls = controls
    this.tabId = tabId
    this.view = view
    this.frame = frame
    this.stateTimer = setInterval(() => void this.sendState(), STATE_MS)
    this.pointerTimer = setInterval(() => this.watchPointer(), POINTER_MS)
    win.showInactive()
    return true
  }

  /**
   * The controls show while the pointer moves over the player and hide when it leaves, as in Chromium's.
   * The player is a drag area, whose pointer moves a Mac keeps from the page, so they're watched here.
   */
  private watchPointer(): void {
    const { win, controls } = this
    if (!win || win.isDestroyed() || !controls || controls.webContents.isDestroyed()) return
    const at = screen.getCursorScreenPoint()
    const box = win.getBounds()
    const inside = at.x >= box.x && at.x < box.x + box.width && at.y >= box.y && at.y < box.y + box.height
    const last = this.pointer
    this.pointer = { ...at, inside }
    const moved = !last || last.x !== at.x || last.y !== at.y
    if (inside ? moved : last?.inside) controls.webContents.send(IPC.event, { type: 'pip.pointer', inside })
  }

  /** Tells the controls where the video is, and follows it when its shape changes (the next Short). */
  private async sendState(): Promise<void> {
    const { frame, view, controls, win } = this
    if (!frame || frame.isDestroyed() || !view || !controls || !win) return
    const raw = (await frame.executeJavaScript(STATE_SCRIPT).catch(() => null)) as RawState | null
    if (!raw || this.frame !== frame || controls.webContents.isDestroyed()) return
    let actions = raw.actions
    const top = view.webContents.isDestroyed() ? null : view.webContents.mainFrame
    if (top && top !== frame) {
      const above = (await top.executeJavaScript(ACTIONS_SCRIPT).catch(() => null)) as RawState['actions']
      if (above) actions = { previous: !!actions?.previous || above.previous, next: !!actions?.next || above.next }
    }
    const state: PipState = {
      time: raw.time,
      duration: raw.duration,
      paused: raw.paused,
      previous: !!actions?.previous,
      next: !!actions?.next
    }
    controls.webContents.send(IPC.event, { type: 'pip.state', state })
    if (raw.width && raw.height && this.video && Math.abs(raw.width / raw.height - this.video.width / this.video.height) > 0.02) {
      this.video = { width: raw.width, height: raw.height }
      this.reshape(clamp(raw.width / raw.height, MIN_ASPECT, MAX_ASPECT))
    }
  }

  /** A new shape for the window, keeping its longest side and the corner nearest the screen's edge. */
  private reshape(aspect: number): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const old = win.getBounds()
    const area = screen.getDisplayMatching(old).workArea
    const size = sizeFor(aspect, Math.max(old.width, old.height), area)
    const right = old.x + old.width / 2 > area.x + area.width / 2
    const bottom = old.y + old.height / 2 > area.y + area.height / 2
    const minimum = minimumFor(aspect)
    win.setAspectRatio(aspect)
    win.setMinimumSize(minimum.width, minimum.height)
    win.setBounds(
      this.within(area, {
        x: right ? old.x + old.width - size.width : old.x,
        y: bottom ? old.y + old.height - size.height : old.y,
        ...size
      })
    )
    this.layout?.()
  }

  /** Whether the floating video has paused. */
  async videoPaused(): Promise<boolean> {
    return (await this.inVideoFrame(PAUSED_SCRIPT)) === true
  }

  /**
   * Plays or pauses the floating video itself, or skips it by some seconds (not another video on its
   * page, like a muted ad in a frame of its own). False when it isn't floating any more.
   */
  async toggleVideo(): Promise<boolean> {
    return (await this.inVideoFrame(TOGGLE_SCRIPT, true)) === true
  }

  async seekVideo(seconds: number): Promise<boolean> {
    return (await this.inVideoFrame(seekScript(seconds), true)) === true
  }

  async seekVideoTo(time: number): Promise<boolean> {
    const done = (await this.inVideoFrame(seekToScript(time), true)) === true
    if (done) void this.sendState()
    return done
  }

  /** The page's own previous or next (the Short before or after), in the video's frame or the page. */
  async track(action: 'previoustrack' | 'nexttrack'): Promise<void> {
    const { frame, view } = this
    if (!frame || frame.isDestroyed() || !view || view.webContents.isDestroyed()) return
    const top = view.webContents.mainFrame
    for (const target of frame === top ? [frame] : [frame, top]) {
      if ((await target.executeJavaScript(trackScript(action), true).catch(() => false)) === true) return
    }
  }

  private async inVideoFrame(script: string, userGesture = false): Promise<unknown> {
    const frame = this.frame
    if (!frame || frame.isDestroyed()) return null
    return frame.executeJavaScript(script, userGesture).catch(() => null)
  }

  /** Puts the video back into its page and closes the player. Returns the view so the caller can re-home it. */
  exit(): WebContentsView | null {
    const view = this.view
    this.cleanup(true)
    return view
  }

  private cleanup(closeWindow: boolean): void {
    const { win, view, controls, cssKey, page } = this
    if (this.stateTimer) clearInterval(this.stateTimer)
    if (this.pointerTimer) clearInterval(this.pointerTimer)
    if (win && !win.isDestroyed()) this.lastBounds = { bounds: win.getBounds(), fraction: this.host.widthFraction() }
    if (view && !view.webContents.isDestroyed()) {
      const wc = view.webContents
      if (cssKey) void wc.removeInsertedCSS(cssKey).catch(() => {})
      unmark(wc)
      // Back at its own scale and size before it goes back to its tab, so the page never sees another
      // size; once it's there (at that size), it's drawn as usual again.
      if (page) {
        wc.enableDeviceEmulation(emulation(page, 1))
        view.setBounds({ x: 0, y: 0, ...page })
        this.restoring.set(
          wc.id,
          setTimeout(() => {
            this.restoring.delete(wc.id)
            if (!wc.isDestroyed() && this.view?.webContents !== wc) wc.disableDeviceEmulation()
          }, RESTORE_MS)
        )
      }
      this.clip?.removeChildView(view)
    }
    this.win = null
    this.controls = null
    this.view = null
    this.frame = null
    this.tabId = null
    this.cssKey = null
    this.page = null
    this.video = null
    this.layout = null
    this.clip = null
    this.stateTimer = null
    this.pointerTimer = null
    this.pointer = null
    // The controls page would outlive the player window otherwise.
    if (controls && !controls.webContents.isDestroyed()) controls.webContents.close()
    if (closeWindow && win && !win.isDestroyed()) win.destroy()
  }

  /** Bottom-right of the current display, or wherever the player was last left. */
  private initialBounds(aspect: number): Rectangle {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const fraction = this.host.widthFraction()
    const last = this.lastBounds?.fraction === fraction ? this.lastBounds.bounds : null
    if (last) {
      const near = screen.getDisplayMatching(last).workArea
      const size = sizeFor(aspect, Math.max(last.width, last.height), near)
      const right = last.x + last.width / 2 > near.x + near.width / 2
      const bottom = last.y + last.height / 2 > near.y + near.height / 2
      return this.within(near, {
        x: right ? last.x + last.width - size.width : last.x,
        y: bottom ? last.y + last.height - size.height : last.y,
        ...size
      })
    }
    // Size relative to the screen, within sensible limits.
    const size = sizeFor(aspect, clamp(area.width * fraction, MIN_LONG, MAX_LONG), area)
    const margin = Math.round(Math.max(MARGIN, area.width * 0.015))
    return { x: area.x + area.width - size.width - margin, y: area.y + area.height - size.height - margin, ...size }
  }

  private within(area: Rectangle, bounds: Rectangle): Rectangle {
    return {
      ...bounds,
      x: Math.round(clamp(bounds.x, area.x, area.x + area.width - bounds.width)),
      y: Math.round(clamp(bounds.y, area.y, area.y + area.height - bounds.height))
    }
  }
}
