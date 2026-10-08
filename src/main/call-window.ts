import { BrowserWindow, WebContentsView, nativeTheme, type Rectangle, type WebContents } from 'electron'

/** The title bar over the call: the traffic lights, the call's site and Back to tab. */
const BAR_HEIGHT = 32
const TRAFFIC_LIGHTS = { x: 12, y: 10 }
/** The bar's colour before it has drawn (--window-base in base.css), so the window never flashes. */
const BAR_DARK = '#1e1e21'
const BAR_LIGHT = '#eaeaed'
const MIN_WIDTH = 240
const MIN_PAGE_HEIGHT = 120
/** How long a page that's closing gets to run its unload handlers before it's closed anyway. */
const CLOSE_PAGE_TIMEOUT_MS = 1000

export interface CallWindowHost {
  preload: string
  load(wc: WebContents, page: string): void
}

/**
 * A page's floating call window (Document Picture-in-Picture: Meet, Teams, Zoom), drawn as Chrome
 * draws it: a title bar with the site and Back to tab, and the page's own window below. Zepper makes
 * the window, so its bar is Zepper's (the window's own web contents) and the page sits under it,
 * rather than filling a plain window. Bottom right of the screen, above everything, on every desktop.
 */
export class CallWindow {
  readonly win: BrowserWindow
  private readonly view: WebContentsView
  private closed = false

  constructor(
    host: CallWindowHost,
    readonly tabId: string,
    readonly page: WebContents,
    size: { width: number; height: number },
    area: Rectangle,
    onClosed: () => void
  ) {
    const margin = Math.round(Math.max(20, area.width * 0.015))
    const width = Math.min(Math.max(size.width, MIN_WIDTH), area.width - 2 * margin)
    const height = Math.min(Math.max(size.height, MIN_PAGE_HEIGHT) + BAR_HEIGHT, area.height - 2 * margin)
    this.win = new BrowserWindow({
      width,
      height,
      x: area.x + area.width - width - margin,
      y: area.y + area.height - height - margin,
      minWidth: MIN_WIDTH,
      minHeight: MIN_PAGE_HEIGHT + BAR_HEIGHT,
      show: false,
      titleBarStyle: 'hidden',
      trafficLightPosition: TRAFFIC_LIGHTS,
      // The first click on it (it never activates Zepper) still hits Back to tab, or the call's buttons.
      acceptFirstMouse: true,
      // A floating panel: stays above full-screen apps and on every desktop, and clicking it doesn't activate Zepper.
      type: 'panel',
      alwaysOnTop: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? BAR_DARK : BAR_LIGHT,
      webPreferences: { preload: host.preload, sandbox: true, contextIsolation: true, partition: 'zepper-ui' }
    })
    this.win.setAlwaysOnTop(true, 'floating')

    this.view = new WebContentsView({ webContents: page })
    this.view.setBackgroundColor('#000000')
    this.win.contentView.addChildView(this.view)
    const layout = (): void => {
      const [w, h] = this.win.getContentSize()
      this.view.setBounds({ x: 0, y: BAR_HEIGHT, width: w, height: Math.max(0, h - BAR_HEIGHT) })
    }
    layout()
    this.win.on('resize', layout)

    const bar = this.win.webContents
    bar.on('will-navigate', (event) => event.preventDefault())
    // The window keeps the site's name (Mission Control, VoiceOver), not the bar page's title.
    this.win.on('page-title-updated', (event) => event.preventDefault())
    bar.setWindowOpenHandler(() => ({ action: 'deny' }))
    host.load(bar, `pip.html?call=${encodeURIComponent(tabId)}`)

    // The page closed its window, or went with its tab: the window goes too.
    page.once('destroyed', () => this.close())
    this.win.once('closed', () => {
      this.closed = true
      this.closePage()
      onClosed()
    })
    // It doesn't take the keyboard from the window you're typing in (it opens as you leave a call).
    this.win.showInactive()
  }

  /** The bar's web contents (Zepper's UI, unlike the page). */
  get bar(): WebContents | null {
    return this.closed || this.win.webContents.isDestroyed() ? null : this.win.webContents
  }

  close(): void {
    if (!this.closed && !this.win.isDestroyed()) this.win.close()
  }

  /** The page's window closes as when you close a window: its unload handlers run, so the call takes its picture back. */
  private closePage(): void {
    const page = this.page
    if (page.isDestroyed()) return
    page.close({ waitForBeforeUnload: true })
    setTimeout(() => {
      if (!page.isDestroyed()) page.close()
    }, CLOSE_PAGE_TIMEOUT_MS)
  }
}
