import { BrowserWindow, WebContentsView, screen, type Rectangle, type WebContents } from 'electron'

/**
 * Marks the page's playing video (and its ancestors) and reports its size;
 * null when nothing is playing. The largest playing video wins, so a muted
 * preview thumbnail never beats the main player.
 */
const MARK_SCRIPT = `(() => {
  const playing = Array.from(document.querySelectorAll('video')).filter(
    (v) => !v.srcObject && !v.paused && !v.ended && v.readyState >= 2 && v.videoWidth >= 160
  )
  const area = (v) => v.getBoundingClientRect().width * v.getBoundingClientRect().height
  const video = playing.sort((a, b) => area(b) - area(a))[0]
  if (!video) return null
  video.setAttribute('data-zepper-pip', '')
  for (let el = video.parentElement; el; el = el.parentElement) el.setAttribute('data-zepper-pip-ancestor', '')
  document.documentElement.setAttribute('data-zepper-pip-active', '')
  return { width: video.videoWidth, height: video.videoHeight }
})()`

const UNMARK_SCRIPT = `(() => {
  document.querySelectorAll('[data-zepper-pip], [data-zepper-pip-ancestor]').forEach((el) => {
    el.removeAttribute('data-zepper-pip')
    el.removeAttribute('data-zepper-pip-ancestor')
  })
  document.documentElement.removeAttribute('data-zepper-pip-active')
})()`

/**
 * Makes the marked video fill the (small) window. Everything else on the page
 * is hidden, and the video's ancestors lose anything that would trap a fixed
 * element (transforms, filters, containment). Author !important beats the
 * player's inline styles.
 */
const PIP_CSS = `
html[data-zepper-pip-active] * { visibility: hidden !important; }
html[data-zepper-pip-active], html[data-zepper-pip-active] body {
  overflow: hidden !important; background: #000 !important;
}
[data-zepper-pip-ancestor] {
  transform: none !important; filter: none !important; backdrop-filter: none !important;
  perspective: none !important; contain: none !important; will-change: auto !important;
  clip-path: none !important; mask: none !important;
}
video[data-zepper-pip] {
  visibility: visible !important;
  position: fixed !important; inset: 0 !important;
  width: 100vw !important; height: 100vh !important;
  max-width: none !important; max-height: none !important;
  margin: 0 !important; transform: none !important;
  object-fit: contain !important; background: #000 !important;
  z-index: 2147483647 !important;
}
`

const MIN_WIDTH = 280
const MAX_WIDTH = 760
const MARGIN = 20
const RADIUS = 14

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
 * Arc-style floating video player. The tab's own web view moves into a small
 * frameless, rounded, resizable, always-on-top window, with the playing video
 * filling it and hover controls layered on top. Coming back to the tab moves
 * the view back.
 */
export class PipPlayer {
  private win: BrowserWindow | null = null
  private controls: WebContentsView | null = null
  private tabId: string | null = null
  private view: WebContentsView | null = null
  private cssKey: string | null = null
  /** Where the player was last left, and at which size setting, so a new video reopens there. */
  private lastBounds: { bounds: Rectangle; fraction: number } | null = null

  constructor(private readonly host: PipHost) {}

  get activeTabId(): string | null {
    return this.tabId
  }

  controlsWebContents(): WebContents | null {
    return this.controls && !this.controls.webContents.isDestroyed() ? this.controls.webContents : null
  }

  /** Floats the tab's playing video. Returns false when the main frame has no playing video. */
  async enter(tabId: string, view: WebContentsView): Promise<boolean> {
    const wc = view.webContents
    let size: { width: number; height: number } | null
    try {
      size = await wc.executeJavaScript(MARK_SCRIPT)
    } catch {
      size = null
    }
    if (!size) return false
    if (this.tabId) this.exit()

    const aspect = Math.min(2.4, Math.max(1.2, size.width / size.height))
    const bounds = this.initialBounds(aspect)
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
      minWidth: 220,
      minHeight: Math.round(220 / aspect),
      backgroundColor: '#00000000',
      webPreferences: { preload: this.host.preload, sandbox: true, contextIsolation: true, partition: 'zepper-ui' }
    })
    win.setAspectRatio(aspect)
    win.setAlwaysOnTop(true, 'floating')

    win.contentView.addChildView(view)
    view.setBorderRadius(RADIUS)
    const controls = new WebContentsView({
      webPreferences: { preload: this.host.preload, sandbox: true, contextIsolation: true, partition: 'zepper-ui' }
    })
    controls.setBackgroundColor('#00000000')
    controls.setBorderRadius(RADIUS)
    win.contentView.addChildView(controls)
    controls.webContents.on('will-navigate', (event) => event.preventDefault())
    this.host.load(controls.webContents, `pip.html?tab=${encodeURIComponent(tabId)}`)

    const layout = (): void => {
      const [width, height] = win.getContentSize()
      view.setBounds({ x: 0, y: 0, width, height })
      controls.setBounds({ x: 0, y: 0, width, height })
    }
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
    win.showInactive()
    return true
  }

  /** Puts the video back into its page and closes the player. Returns the view so the caller can re-home it. */
  exit(): WebContentsView | null {
    const view = this.view
    this.cleanup(true)
    return view
  }

  private cleanup(closeWindow: boolean): void {
    const { win, view, controls, cssKey } = this
    if (win && !win.isDestroyed()) this.lastBounds = { bounds: win.getBounds(), fraction: this.host.widthFraction() }
    if (view && !view.webContents.isDestroyed()) {
      if (cssKey) void view.webContents.removeInsertedCSS(cssKey).catch(() => {})
      void view.webContents.executeJavaScript(UNMARK_SCRIPT).catch(() => {})
      if (win && !win.isDestroyed()) win.contentView.removeChildView(view)
    }
    this.win = null
    this.controls = null
    this.view = null
    this.tabId = null
    this.cssKey = null
    // The controls page would outlive the player window otherwise.
    if (controls && !controls.webContents.isDestroyed()) controls.webContents.close()
    if (closeWindow && win && !win.isDestroyed()) win.destroy()
  }

  /** Bottom-right of the current display, or wherever the player was last left. */
  private initialBounds(aspect: number): Rectangle {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = display.workArea
    const fraction = this.host.widthFraction()
    if (this.lastBounds && this.lastBounds.fraction === fraction) {
      const { bounds } = this.lastBounds
      return { ...bounds, height: Math.round(bounds.width / aspect) }
    }
    // Size relative to the screen, within sensible limits.
    const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, area.width * fraction)))
    const height = Math.round(width / aspect)
    const margin = Math.round(Math.max(MARGIN, area.width * 0.015))
    return { x: area.x + area.width - width - margin, y: area.y + area.height - height - margin, width, height }
  }
}
