import {
  BrowserWindow,
  ClipboardItem,
  Menu,
  WebContentsView,
  app,
  clipboard,
  dialog,
  nativeTheme,
  shell,
  type ContextMenuParams,
  type DownloadItem,
  type PermissionCheckHandlerHandlerDetails,
  type Session,
  type HandlerDetails,
  type MenuItemConstructorOptions,
  type Rectangle,
  type WebContents,
  type WindowOpenHandlerResponse
} from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { PIP_WIDTH, type Settings } from '@shared/settings'
import { DEFAULT_THEME } from '@shared/theme'
import {
  IPC,
  type Command,
  type OverlayMode,
  type PermissionPrompt,
  type PermissionState,
  type Rect,
  type Pane,
  type SiteInfo,
  type Snapshot,
  type Space,
  type SpaceTheme,
  type Split,
  type SplitLayout,
  type Suggestion,
  type Tab,
  type TabKind,
  type ToastSpec,
  type UiEvent
} from '@shared/types'
import type { Hub } from './hub'
import { PipPlayer } from './pip'
import { startDebugServer } from './devtools-server'
import { JsonFile } from './persist'
import { parse as parseDomain } from 'tldts-experimental'
import { SitePermissions, originOf, promptLabel, settingKeys } from './site'
import { suggest } from './suggest'
import { resolveInput, searchUrl, setSearchEngine, stripHash, stripTracking } from './url'

/** Height reserved for the traffic lights when the sidebar is on the right. */
const TITLEBAR_STRIP = 34
const MIN_SIDEBAR = 170
const MAX_SIDEBAR = 500
const DEFAULT_SIDEBAR = 250
const MAX_ESSENTIALS = 12
/** Top-right overlay region for toasts and the find bar. */
const CORNER_REGION = { width: 440, height: 240 }

type PersistedTab = Pick<
  Tab,
  'id' | 'kind' | 'spaceId' | 'url' | 'title' | 'favicon' | 'pinned' | 'lastActiveAt'
>

interface PersistedState {
  version: 1
  spaces: Space[]
  tabs: PersistedTab[]
  activeSpaceId: string
  activeTabId: string | null
  sidebarWidth: number
  compact: boolean
  adblockEnabled: boolean
  splits?: Split[]
}

const MAX_SPLIT_PANES = 4

interface PendingPrompt extends PermissionPrompt {
  keys: string[]
  tabId: string | undefined
  callback: (granted: boolean) => void
}

interface ClosedTab {
  url: string
  title: string
  favicon: string | null
  spaceId: string | null
  batch: number
}

function makeTab(fields: Partial<Tab> & Pick<Tab, 'kind' | 'url'>): Tab {
  return {
    id: randomUUID(),
    spaceId: null,
    title: fields.url,
    favicon: null,
    pinned: null,
    loaded: false,
    loading: false,
    audible: false,
    muted: false,
    canGoBack: false,
    canGoForward: false,
    lastActiveAt: Date.now(),
    blockedCount: 0,
    media: null,
    audibleAt: 0,
    ...fields
  }
}

/** Reads the page's Media Session metadata (title, artist, artwork) if it publishes any. */
const MEDIA_METADATA_SCRIPT = `(() => {
  const m = navigator.mediaSession && navigator.mediaSession.metadata
  if (!m) return null
  const art = (m.artwork || []).slice().sort((a, b) => parseInt(b.sizes || '0') - parseInt(a.sizes || '0'))[0]
  return { title: m.title || '', artist: m.artist || m.album || '', artwork: art ? new URL(art.src, location.href).href : null }
})()`

/** Pops a playing, audible video into picture-in-picture. Needs a user gesture, which executeJavaScript can grant. */
const AUTO_PIP_SCRIPT = `(async () => {
  if (document.pictureInPictureElement) return 'already'
  const video = Array.from(document.querySelectorAll('video')).find(
    (v) => !v.paused && !v.ended && !v.muted && v.volume > 0 && v.readyState >= 2 && v.videoWidth >= 160 && !v.disablePictureInPicture
  )
  if (!video) return 'none'
  await video.requestPictureInPicture()
  window.__zepperAutoPip = true
  return 'pip'
})()`

/** Brings an auto-started picture-in-picture video back into the page. */
const EXIT_AUTO_PIP_SCRIPT = `(() => {
  if (!window.__zepperAutoPip || !document.pictureInPictureElement) return false
  window.__zepperAutoPip = false
  document.exitPictureInPicture()
  return true
})()`

/** Pauses every playing video and audio element. */
const MEDIA_PAUSE_SCRIPT = `(() => {
  document.querySelectorAll('video, audio').forEach((el) => { if (!el.paused) el.pause() })
})()`

/** Pauses whatever is playing, or resumes what we paused last time. */
const MEDIA_TOGGLE_SCRIPT = `(() => {
  const media = Array.from(document.querySelectorAll('video, audio'))
  const playing = media.filter((el) => !el.paused)
  if (playing.length) {
    playing.forEach((el) => el.pause())
    window.__zepperPaused = playing
    return 'paused'
  }
  const resume = (window.__zepperPaused || media).filter((el) => el.isConnected)
  if (resume[0]) resume[0].play()
  return 'playing'
})()`

function makeSpace(name: string, icon: string, theme: SpaceTheme = DEFAULT_THEME): Space {
  return { id: randomUUID(), name, icon, theme, collapsedPins: false, lastTabId: null }
}

/**
 * Owns all browser state for the window: spaces, tabs (Essentials, pinned and
 * normal), the web views behind them, and the overlay used for the command
 * palette, toasts and popovers. Renderers only display snapshots of this
 * state and send commands back.
 */
/** main: the persistent window; blank: temporary tabs, shared sign-ins; private: throwaway session. */
export type BrowserKind = 'main' | 'blank' | 'private'

export class Browser {
  private win!: BrowserWindow
  private overlay!: WebContentsView
  private readonly views = new Map<string, WebContentsView>()
  private readonly tabByWebContents = new Map<number, string>()
  private readonly openers = new Map<string, string>()
  private readonly stateFile: JsonFile<PersistedState> | null

  private spaces: Space[]
  private tabs: Tab[]
  private activeSpaceId: string
  private activeTabId: string | null = null
  private sidebarWidth: number
  private compact: boolean
  private closed: ClosedTab[] = []
  private closeBatch = 0
  private overlayMode: OverlayMode = 'hidden'
  private paletteOpen = false
  private htmlFullscreen = false
  private broadcastTimer: NodeJS.Timeout | null = null
  private blockedTimer: NodeJS.Timeout | null = null
  private restoreTabId: string | null = null
  private readonly permissions: SitePermissions
  private prompts: PendingPrompt[] = []
  private promptSeq = 0
  private showingPrompt: number | null = null
  private lastFindText = ''
  private peeking = false
  /** Horizontal offset applied to the active view while a swipe gesture is in progress. */
  private swipeOffset = 0
  private layoutAnimation: NodeJS.Timeout | null = null
  private pip!: PipPlayer
  private readonly disposers: (() => void)[] = []
  /** Tabs we already offered to pause other media for, so the tip never nags. */
  private readonly mediaTipShown = new Set<string>()
  /** Set once the window has closed; late events from dying pages are ignored. */
  private windowClosed = false
  private splits: Split[] = []
  /** Tabs whose views are currently attached to the window (one, or a split's panes). */
  private readonly attached = new Set<string>()
  /** Ctrl+Tab most-recently-used cycling: the order captured when cycling began. */
  private recentCycle: { order: string[]; index: number; timer: NodeJS.Timeout | null } | null = null

  constructor(
    private readonly hub: Hub,
    readonly kind: BrowserKind,
    private readonly ses: Session
  ) {
    this.stateFile = kind === 'main' ? new JsonFile<PersistedState>('zepper-state.json', 800) : null
    this.permissions = kind === 'private' ? new SitePermissions(false) : hub.services.permissions
    const saved = this.stateFile?.read()
    if (saved?.version === 1 && saved.spaces.length > 0) {
      this.spaces = saved.spaces
      this.tabs = saved.tabs.map((t) => makeTab(t))
      this.activeSpaceId = saved.spaces.some((s) => s.id === saved.activeSpaceId)
        ? saved.activeSpaceId
        : saved.spaces[0].id
      this.restoreTabId = saved.activeTabId
      const ids = new Set(this.tabs.map((t) => t.id))
      this.splits = (saved.splits ?? [])
        .map((split) => ({ ...split, tabIds: split.tabIds.filter((id) => ids.has(id)) }))
        .filter((split) => split.tabIds.length >= 2)
      this.sidebarWidth = Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, saved.sidebarWidth ?? DEFAULT_SIDEBAR))
      this.compact = saved.compact ?? false
    } else if (kind === 'private') {
      const space = makeSpace('Private', '🕶️', { colors: ['#3b2a6b', '#1b1934'], opacity: 0.7, texture: 0.15, scheme: 'dark' })
      this.spaces = [space]
      this.tabs = []
      this.activeSpaceId = space.id
      this.sidebarWidth = DEFAULT_SIDEBAR
      this.compact = false
    } else if (kind === 'blank') {
      const space = makeSpace('New Window', '🪟')
      this.spaces = [space]
      this.tabs = []
      this.activeSpaceId = space.id
      this.sidebarWidth = DEFAULT_SIDEBAR
      this.compact = false
    } else {
      const space = makeSpace('Personal', '😀')
      this.spaces = [space]
      this.tabs = []
      this.activeSpaceId = space.id
      this.sidebarWidth = DEFAULT_SIDEBAR
      this.compact = false
    }
  }

  private get history() {
    return this.hub.services.history
  }

  private get adblock() {
    return this.hub.services.adblock
  }

  private get settingsStore() {
    return this.hub.services.settings
  }

  private get certificates() {
    return this.hub.services.certificates
  }

  /** Chrome extensions only run in the shared session, never in private windows. */
  private get extensions() {
    return this.kind === 'private' ? null : this.hub.services.extensions
  }

  // ---------------------------------------------------------------------------
  // Window lifecycle

  start(): void {
    const { rendererUrl, rendererDir } = this.hub.services
    const preload = join(__dirname, '../preload/index.js')
    const uiPrefs = { preload, contextIsolation: true, sandbox: true, partition: 'zepper-ui' }

    const offset = this.kind === 'main' ? {} : { x: undefined, y: undefined }
    this.win = new BrowserWindow({
      ...offset,
      width: this.kind === 'main' ? 1440 : 1280,
      height: this.kind === 'main' ? 900 : 820,
      minWidth: 640,
      minHeight: 495,
      show: false,
      titleBarStyle: 'hidden',
      // Let the first click on an inactive window hit the button under it.
      acceptFirstMouse: true,
      trafficLightPosition: { x: 17, y: 17 },
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
      backgroundColor: '#00000000',
      webPreferences: uiPrefs
    })

    this.overlay = new WebContentsView({ webPreferences: uiPrefs })
    this.overlay.setBackgroundColor('#00000000')
    this.overlay.setVisible(false)
    this.win.contentView.addChildView(this.overlay)

    for (const wc of [this.win.webContents, this.overlay.webContents]) {
      this.watchControlKey(wc)
      wc.on('will-navigate', (event) => event.preventDefault())
      wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    }

    const load = (wc: WebContents, page: string): void => {
      if (rendererUrl) void wc.loadURL(`${rendererUrl}/${page}`)
      else void wc.loadFile(join(rendererDir, page))
    }
    load(this.win.webContents, 'chrome.html')
    load(this.overlay.webContents, 'overlay.html')

    this.win.once('ready-to-show', () => this.win.show())
    this.win.on('resize', () => this.layout())
    this.win.on('focus', () => this.broadcast())
    this.win.on('blur', () => this.broadcast())
    this.win.on('closed', () => this.destroy())
    const onTheme = (): void => this.broadcast()
    nativeTheme.on('updated', onTheme)
    this.disposers.push(() => nativeTheme.off('updated', onTheme))

    this.pip = new PipPlayer({
      preload,
      load,
      widthFraction: () => PIP_WIDTH[this.settings.pipSize] ?? PIP_WIDTH.medium,
      onBack: (tabId) => this.pipBack(tabId),
      onClosed: (tabId) => this.pauseTab(tabId)
    })

    this.overlay.webContents.once('did-finish-load', () => {
      const restore = this.restoreTabId && this.tab(this.restoreTabId)
      if (restore) this.activateTab(restore.id)
      else this.openPalette('new')
    })

    this.applySettings(this.settings, null)
    this.disposers.push(this.settingsStore.onChange((next, prev) => this.applySettings(next, prev)))
    this.win.setWindowButtonVisibility(!this.compact)
    this.layout()

    if (this.kind !== 'main') return
    startDebugServer({
      layers: () => {
        const layers = [{ name: 'chrome', webContents: this.win.webContents, bounds: this.windowBounds() }]
        for (const id of this.attached) {
          const view = this.views.get(id)
          if (view) layers.push({ name: `tab-${layers.length}`, webContents: view.webContents, bounds: view.getBounds() })
        }
        if (this.overlayMode !== 'hidden') {
          layers.push({ name: 'overlay', webContents: this.overlay.webContents, bounds: this.overlay.getBounds() })
        }
        return layers
      },
      handle: (command) => this.handle(command),
      snapshotJson: () => this.snapshot(),
      evaluate: async (code) => this.activeWebContents()?.executeJavaScript(code, true) ?? null,
      drag: (layer, from, to) => {
        const target = layer === 'chrome' ? this.win.webContents : layer === 'tab' ? this.activeWebContents() : this.overlay.webContents
        const origin = layer === 'overlay' ? this.overlay.getBounds() : layer === 'tab' ? this.contentBounds() : { x: 0, y: 0 }
        if (!target) return
        const at = (p: [number, number]) => ({ x: Math.round(p[0] - origin.x), y: Math.round(p[1] - origin.y) })
        target.sendInputEvent({ type: 'mouseDown', ...at(from), button: 'left', clickCount: 1 })
        const steps = 12
        for (let i = 1; i <= steps; i++) {
          setTimeout(() => {
            const p: [number, number] = [from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]
            target.sendInputEvent({ type: 'mouseMove', ...at(p), button: 'left' })
            if (i === steps) target.sendInputEvent({ type: 'mouseUp', ...at(to), button: 'left', clickCount: 1 })
          }, i * 16)
        }
      },
      wheel: (dx, steps, layer, at) => {
        const wc = layer === 'chrome' ? this.win.webContents : this.activeWebContents()
        if (!wc) return
        const { width, height } = this.contentBounds()
        const [x, y] = at ?? [width / 2, height / 2]
        for (let i = 0; i < steps; i++) {
          setTimeout(() => {
            wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: dx, deltaY: 0, hasPreciseScrollingDeltas: true, canScroll: true })
          }, i * 16)
        }
      }
    })
  }

  /** A page asked for a permission (routed here by the hub): allow, block, or ask. */
  requestPermission(
    wc: WebContents,
    permission: string,
    callback: (granted: boolean) => void,
    details: Electron.PermissionRequest | Electron.MediaAccessPermissionRequest | Electron.OpenExternalPermissionRequest
  ): void {
    if (this.permissions.isAlwaysAllowed(permission)) return callback(true)
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes as string[] | undefined) : undefined
    const keys = settingKeys(permission, mediaTypes)
    if (!keys) return callback(false)
    const origin = originOf(details.requestingUrl ?? wc.getURL())
    const states = keys.map((k) => this.permissions.get(origin, k))
    if (states.includes('block')) return callback(false)
    if (states.every((s) => s === 'allow')) return callback(true)
    this.prompts.push({
      id: ++this.promptSeq,
      origin,
      host: safeHost(origin) || origin,
      label: promptLabel(permission, keys),
      keys,
      tabId: this.tabByWebContents.get(wc.id),
      callback
    })
    wc.once('destroyed', () => this.dropPrompts((p) => p.tabId === this.tabByWebContents.get(wc.id)))
    this.showNextPrompt()
  }

  checkPermission(permission: string, requestingOrigin: string, details: PermissionCheckHandlerHandlerDetails): boolean {
    if (this.permissions.isAlwaysAllowed(permission)) return true
    const mediaType = 'mediaType' in details ? (details.mediaType as string | undefined) : undefined
    const keys = settingKeys(permission, mediaType && mediaType !== 'unknown' ? [mediaType] : undefined)
    if (!keys) return true
    return keys.every((k) => this.permissions.get(originOf(requestingOrigin), k) === 'allow')
  }

  handleDownload(item: DownloadItem): void {
    const path = uniquePath(join(app.getPath('downloads'), item.getFilename()))
    item.setSavePath(path)
    const name = basename(path)
    this.toast({ id: `download-${name}`, message: 'Downloading…', description: name, timeout: 2500 })
    item.on('updated', () => {
      const total = item.getTotalBytes()
      if (total > 0 && !this.win.isDestroyed()) this.win.setProgressBar(item.getReceivedBytes() / total)
    })
    item.once('done', (_e, state) => {
      if (!this.win.isDestroyed()) this.win.setProgressBar(-1)
      if (state === 'completed') {
        app.dock?.downloadFinished(path)
        this.toast({
          id: `download-${name}`,
          message: 'Download complete',
          description: name,
          action: { label: 'Show', command: { type: 'download.show', path } },
          timeout: 5000
        })
      } else if (state === 'interrupted') {
        this.toast({ id: `download-${name}`, message: 'Download failed', description: name, timeout: 4000 })
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Hub routing

  owns(wc: WebContents): boolean {
    return this.ownsWebContentsId(wc.id)
  }

  ownsWebContentsId(id: number): boolean {
    if (!this.win || this.win.isDestroyed()) return false
    return (
      id === this.win.webContents.id ||
      id === this.overlay.webContents.id ||
      id === this.pip?.controlsWebContents()?.id ||
      this.tabByWebContents.has(id)
    )
  }

  publicSnapshot(): Snapshot {
    return this.snapshot()
  }

  suggestions(text: string): Promise<Suggestion[]> {
    // Private windows don't draw on (or show) browsing history.
    return suggest(text, this.tabs, this.history, this.settings.searchSuggestions, this.kind === 'private')
  }

  /** Commands from this window's own UI (chrome, overlay, player controls) only, never from web pages. */
  handleFromUi(sender: WebContents, command: Command): void {
    const ui = [this.win.webContents.id, this.overlay.webContents.id, this.pip.controlsWebContents()?.id]
    if (!ui.includes(sender.id)) return
    this.handle(command)
  }

  activateByWebContents(wc: WebContents): void {
    const id = this.tabByWebContents.get(wc.id)
    if (id) this.activateTab(id)
  }

  /**
   * The extensions layer reports every tab page that goes away, including the
   * ones torn down because this window is closing; those must not touch the
   * saved tabs (or the destroyed window).
   */
  removeByWebContents(wc: WebContents): void {
    if (this.windowClosed || this.win.isDestroyed()) return
    const tab = this.tab(this.tabByWebContents.get(wc.id))
    if (tab) this.removeTab(tab)
  }

  openTabForExtension(url: string, active: boolean): WebContents {
    const tab = this.openTab(url, { background: !active })
    return this.ensureView(tab).webContents
  }

  /** "Back to tab" from Chromium's own picture-in-picture window (iframe videos). */
  onNativePipBack(webContentsId: number): void {
    const id = this.tabByWebContents.get(webContentsId)
    if (id && id !== this.activeTabId) this.pipBack(id)
  }

  focusWindow(): void {
    if (this.win.isMinimized()) this.win.restore()
    this.win.show()
    this.win.focus()
  }

  /** Window closed: release every page, and for private windows wipe the session. */
  private destroy(): void {
    this.windowClosed = true
    this.persistNow()
    this.pip?.exit()
    for (const dispose of this.disposers) dispose()
    for (const view of this.views.values()) {
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }
    this.views.clear()
    this.tabByWebContents.clear()
    if (this.kind === 'private') void this.ses.clearStorageData().catch(() => {})
    this.hub.windowClosed(this)
  }

  window(): BrowserWindow {
    return this.win
  }

  persistNow(): void {
    if (!this.stateFile) return
    this.stateFile.schedule(this.persistedState())
    this.stateFile.flush()
  }

  // ---------------------------------------------------------------------------
  // Commands

  handle(command: Command): void {
    switch (command.type) {
      case 'tab.activate':
        return this.activateTab(command.tabId)
      case 'tab.close':
        return this.closeTab(command.tabId)
      case 'tab.middleClick':
        return this.middleClick(command.tabId)
      case 'tab.open':
        return this.openInput(command.input, command.where)
      case 'tab.pin':
        return this.pin(command.tabId)
      case 'tab.unpin':
        return this.unpin(command.tabId)
      case 'tab.addEssential':
        return this.addEssential(command.tabId)
      case 'tab.removeEssential':
        return this.removeEssential(command.tabId)
      case 'tab.resetPinned':
        return this.resetPinned(command.tabId, command.separate ?? false)
      case 'tab.unload':
        return this.unload(command.tabId)
      case 'tab.toggleMute':
        return this.toggleMute(command.tabId)
      case 'tab.contextMenu':
        return this.tabContextMenu(command.tabId)
      case 'tab.reopenClosed':
        return this.reopenClosed()
      case 'nav.back':
        return this.activeWebContents()?.navigationHistory.goBack()
      case 'nav.forward':
        return this.activeWebContents()?.navigationHistory.goForward()
      case 'nav.reload':
        return this.activeWebContents()?.reload()
      case 'space.switch':
        return this.switchSpace(command.spaceId)
      case 'space.switchRelative':
        return this.switchSpaceRelative(command.delta)
      case 'space.create':
        return this.createSpace(command.name, command.icon, command.theme)
      case 'space.update':
        return this.updateSpace(command.spaceId, command.patch)
      case 'space.contextMenu':
        return this.spaceContextMenu(command.spaceId, command.anchor)
      case 'space.clearTabs':
        return this.clearTabs(command.spaceId)
      case 'ui.setSidebarWidth':
        this.sidebarWidth = Math.round(Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, command.width)))
        this.layout()
        return this.broadcast()
      case 'ui.openPalette':
        return this.openPalette(command.mode)
      case 'ui.closePalette':
        return this.closePalette(command.refocus)
      case 'ui.overlayMode':
        return this.setOverlayMode(command.mode)
      case 'ui.openPopover':
        this.setOverlayMode('full')
        this.overlay.webContents.focus()
        return this.emit({ type: 'popover.open', popover: command.popover }, 'overlay')
      case 'ui.copyUrl':
        return this.copyUrl(command.markdown ?? false)
      case 'ui.newMenu':
        return this.newMenu(command.anchor)
      case 'ui.settingsMenu':
        return this.settingsMenu(command.anchor)
      case 'ui.toggleCompact':
        return this.toggleCompact()
      case 'ui.siteInfo':
        return void this.openSiteInfo(command.anchor)
      case 'site.clearDomain':
        return void this.clearDomain(command.domain)
      case 'site.exportCertificate':
        return void this.exportCertificate(command.index)
      case 'clipboard.write':
        return void clipboard.writeText(command.text)
      case 'media.toggle':
        return void this.views.get(command.tabId)?.webContents.executeJavaScript(MEDIA_TOGGLE_SCRIPT, true).catch(() => {})
      case 'media.pauseOthers':
        return this.pauseOthers(command.keepTabId)
      case 'pip.back': {
        const id = this.pip.activeTabId
        if (id) this.pipBack(id)
        return
      }
      case 'pip.close': {
        const id = this.pip.activeTabId
        if (!id) return
        this.pauseTab(id)
        this.pip.exit()
        return
      }
      case 'media.dismiss': {
        const tab = this.tab(command.tabId)
        if (tab) tab.media = null
        return this.broadcast()
      }
      case 'site.setPermission':
        this.permissions.set(command.origin, command.permission, command.state)
        return
      case 'site.clearData':
        return void this.clearSiteData(command.origin)
      case 'permission.respond':
        return this.respondToPrompt(command.id, command.allow)
      case 'find.query':
        return this.find(command.text, command.forward, command.findNext)
      case 'find.stop':
        this.activeWebContents()?.stopFindInPage('clearSelection')
        return
      case 'download.show':
        return shell.showItemInFolder(command.path)
      case 'settings.update':
        return this.settingsStore.update(command.patch)
      case 'ui.openSettings':
        this.setOverlayMode('full')
        this.overlay.webContents.focus()
        return this.emit({ type: 'settings.open' }, 'overlay')
      case 'ui.peekSidebar':
        return this.setPeek(command.show)
      case 'ui.dismissOverlay':
        return this.emit({ type: 'overlay.dismiss' }, 'overlay')
      case 'split.add':
        return this.addToSplit(command.tabId)
      case 'split.remove':
        return this.removeFromSplit(command.tabId)
      case 'split.dissolve':
        return this.dissolveSplit(command.splitId)
      case 'split.layout': {
        const split = this.splits.find((x) => x.id === command.splitId)
        if (split) {
          split.layout = command.layout
          split.sizes = evenSizes(command.layout === 'grid' ? 1 : split.tabIds.length)
        }
        this.layout()
        return this.broadcast()
      }
      case 'split.resize': {
        const split = this.splits.find((x) => x.id === command.splitId)
        if (split) split.sizes = command.sizes
        this.layout()
        return this.broadcast()
      }
      case 'ui.createSpace':
        this.setOverlayMode('full')
        this.overlay.webContents.focus()
        return this.emit({ type: 'space.startCreate' }, 'overlay')
    }
  }

  private get settings(): Settings {
    return this.settingsStore.get()
  }

  private applySettings(next: Settings, prev: Settings | null): void {
    nativeTheme.themeSource = next.colorScheme
    setSearchEngine(next.searchEngine)
    this.adblock.setEnabled(next.adblock)
    const layoutChanged =
      !prev ||
      prev.contentGap !== next.contentGap ||
      prev.cornerRadius !== next.cornerRadius ||
      prev.sidebarPosition !== next.sidebarPosition
    if (layoutChanged && prev) this.animateLayout()
    else if (layoutChanged) this.layout()
    this.broadcast()
  }

  // ---------------------------------------------------------------------------
  // Tabs

  private tab(id: string | null | undefined): Tab | undefined {
    return id ? this.tabs.find((t) => t.id === id) : undefined
  }

  private space(id: string): Space | undefined {
    return this.spaces.find((s) => s.id === id)
  }

  /** Tabs in sidebar order for the active space: Essentials, pinned, then normal. */
  visibleTabs(): Tab[] {
    const inSpace = (kind: TabKind): Tab[] =>
      this.tabs.filter((t) => t.kind === kind && t.spaceId === this.activeSpaceId)
    return [...this.tabs.filter((t) => t.kind === 'essential'), ...inSpace('pinned'), ...inSpace('normal')]
  }

  private activeWebContents(): WebContents | undefined {
    return this.activeTabId ? this.views.get(this.activeTabId)?.webContents : undefined
  }

  /** Opens a URL in a new normal tab at the top of a space's list (newest first). */
  openTab(
    url: string,
    options: { spaceId?: string; background?: boolean; afterTabId?: string } = {}
  ): Tab {
    const tab = makeTab({ kind: 'normal', url, spaceId: options.spaceId ?? this.activeSpaceId })
    this.insertNormalTab(tab, options.afterTabId)
    if (options.background) {
      this.broadcast()
    } else {
      this.activateTab(tab.id)
    }
    return tab
  }

  private insertNormalTab(tab: Tab, afterTabId?: string): void {
    const after = this.tab(afterTabId)
    if (after && after.kind === 'normal' && after.spaceId === tab.spaceId) {
      this.tabs.splice(this.tabs.indexOf(after) + 1, 0, tab)
    } else if (this.settings.newTabPosition === 'bottom') {
      this.tabs.push(tab)
    } else {
      this.tabs.unshift(tab)
    }
  }

  private openInput(input: string, where: 'new' | 'current' | 'split'): void {
    const url = resolveInput(input)
    const current = this.tab(this.activeTabId)
    if (where === 'split') {
      const tab = makeTab({ kind: 'normal', url, spaceId: this.activeSpaceId })
      this.insertNormalTab(tab, current?.kind === 'normal' ? current.id : undefined)
      if (current) this.addToSplit(tab.id)
      else this.activateTab(tab.id)
      return
    }
    // Like Zen, navigating a pinned tab or Essential away from its site opens a new tab instead.
    const leavesPin =
      current?.pinned && new URL(url).host !== safeHost(current.pinned.url) && where === 'current'
    if (where === 'new' || !current || leavesPin) {
      this.openTab(url)
      return
    }
    const view = this.ensureView(current)
    void view.webContents.loadURL(url)
    this.activateTab(current.id)
  }

  activateTab(id: string, options: { keepRecency?: boolean } = {}): void {
    const tab = this.tab(id)
    if (!tab) return
    const previousId = this.activeTabId
    const sameSplit = !!previousId && this.splitOf(previousId) !== undefined && this.splitOf(previousId) === this.splitOf(id)
    if (previousId && previousId !== id && !sameSplit) void this.autoPictureInPicture(previousId)
    if (tab.kind !== 'essential' && tab.spaceId && tab.spaceId !== this.activeSpaceId) {
      this.activeSpaceId = tab.spaceId
    }
    if (this.pip.activeTabId === id) this.pip.exit()
    this.activeTabId = id
    const view = this.ensureView(tab)
    this.syncAttachedViews()

    if (!options.keepRecency) tab.lastActiveAt = Date.now()
    const space = this.space(this.activeSpaceId)
    if (space) space.lastTabId = id
    this.layout()
    if (!this.paletteOpen && this.overlayMode !== 'full') view.webContents.focus()
    this.extensions?.api.selectTab(view.webContents)
    this.broadcast()
    this.showNextPrompt()
    this.runInFrames(view.webContents, EXIT_AUTO_PIP_SCRIPT, false)
  }

  /** Arc-style auto picture-in-picture: a playing video floats when you leave its tab. */
  private async autoPictureInPicture(tabId: string): Promise<void> {
    if (!this.settings.autoPictureInPicture) return
    const tab = this.tab(tabId)
    const wc = this.views.get(tabId)?.webContents
    const view = this.views.get(tabId)
    if (!tab?.audible || tab.muted || !wc || !view) return
    if (this.attached.has(tabId)) return
    // Our floating player handles videos in the page itself; iframe videos fall back to Chromium's.
    let entered = await this.pip.enter(tabId, view)
    if (entered && (this.activeTabId === tabId || this.attached.has(tabId))) {
      this.pip.exit()
      this.syncAttachedViews()
      return
    }
    if (!entered) entered = await this.runInFrames(wc, AUTO_PIP_SCRIPT, true, 'pip')
    if (!app.isPackaged) console.info(`[pip] picture-in-picture for ${tab.title}: ${entered ? 'entered' : 'no playing video'}`)
  }

  /** "Back to tab" from the floating player: show the tab and bring the window forward. */
  private pipBack(tabId: string): void {
    this.activateTab(tabId)
    this.focusWindow()
  }

  private pauseTab(tabId: string): void {
    const wc = this.views.get(tabId)?.webContents
    if (wc) void this.runInFrames(wc, MEDIA_PAUSE_SCRIPT, false)
  }

  private pauseOthers(keepTabId: string): void {
    for (const tab of this.tabs) if (tab.audible && !tab.muted && tab.id !== keepTabId) this.pauseTab(tab.id)
  }

  /**
   * Started something while another tab is still playing? Offer to pause the
   * rest, once per tab, so old videos don't keep talking over the new one.
   */
  private offerToPauseOthers(tabId: string): void {
    const behavior = this.settings.otherMedia
    if (this.tab(tabId)?.muted) return
    const others = this.tabs.filter((t) => t.audible && t.id !== tabId && !t.muted)
    if (behavior === 'nothing' || others.length === 0) return
    const names = others.map((t) => t.media?.title || t.title).slice(0, 2).join(', ')
    if (behavior === 'pause') {
      this.pauseOthers(tabId)
      this.toast({ id: 'media-others', message: others.length === 1 ? 'Paused the other tab' : `Paused ${others.length} other tabs`, description: names, timeout: 3000 })
      return
    }
    if (this.mediaTipShown.has(tabId)) return
    this.mediaTipShown.add(tabId)
    this.toast({
      id: 'media-others',
      message: others.length === 1 ? 'Another tab is still playing' : `${others.length} other tabs are playing`,
      description: names,
      action: { label: others.length === 1 ? 'Pause it' : 'Pause others', command: { type: 'media.pauseOthers', keepTabId: tabId } },
      timeout: 6000
    })
  }

  /** Whether any frame of a tab currently shows picture-in-picture (dev checks). */
  async isInPictureInPicture(tabId: string): Promise<boolean> {
    const wc = this.views.get(tabId)?.webContents
    if (!wc) return false
    for (const frame of wc.mainFrame.framesInSubtree) {
      try {
        if (await frame.executeJavaScript('!!document.pictureInPictureElement')) return true
      } catch {
        // ignore
      }
    }
    return false
  }

  /** Runs a script in every frame (videos are often in iframes), stopping at the first frame returning `stopOn`. */
  private async runInFrames(wc: WebContents, script: string, userGesture: boolean, stopOn?: unknown): Promise<boolean> {
    if (wc.isDestroyed()) return false
    for (const frame of wc.mainFrame.framesInSubtree) {
      try {
        const result = await frame.executeJavaScript(script, userGesture)
        if (stopOn !== undefined && result === stopOn) return true
      } catch {
        // Cross-origin or detached frames can refuse; try the next one.
      }
    }
    return false
  }

  private clearActiveTab(): void {
    if (this.activeTabId) void this.autoPictureInPicture(this.activeTabId)
    this.activeTabId = null
    this.syncAttachedViews()
    const space = this.space(this.activeSpaceId)
    if (space) space.lastTabId = null
    this.broadcast()
  }

  /** Next tab after closing or unloading the active one: opener, then most recently used. */
  private pickNextTab(leaving: Tab): Tab | undefined {
    const candidates = this.visibleTabs().filter(
      (t) => t.id !== leaving.id && (t.kind === 'normal' || t.loaded)
    )
    const opener = this.tab(this.openers.get(leaving.id))
    if (opener && candidates.includes(opener)) return opener
    if (!this.settings.closeSelectsRecent) {
      const visible = this.visibleTabs()
      const index = visible.indexOf(leaving)
      const below = visible.slice(index + 1).find((t) => candidates.includes(t))
      const above = visible.slice(0, index).reverse().find((t) => candidates.includes(t))
      return below ?? above
    }
    return candidates.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
  }

  private closeTab(id: string): void {
    const tab = this.tab(id)
    if (!tab) return
    if (tab.kind !== 'normal') {
      this.closePinned(tab)
      return
    }
    this.closed.push({ ...tab, batch: ++this.closeBatch })
    this.removeTab(tab)
  }

  /** ⌘W on a pinned tab or Essential, following the "pinned close behaviour" setting. */
  private closePinned(tab: Tab): void {
    const behavior = this.settings.pinnedCloseBehavior
    const resetUrl = behavior.startsWith('reset') || behavior === 'reset'
    if (behavior === 'close' && tab.kind === 'pinned') return this.removeTab(tab)
    if (behavior === 'reset-unload-switch' || behavior === 'unload-switch') return this.unloadPinned(tab, resetUrl)
    if (behavior === 'reset') return this.resetPinned(tab.id, false)
    // reset-switch / switch: keep the page loaded but move away from it.
    if (resetUrl && tab.pinned) {
      Object.assign(tab, tab.pinned)
      void this.views.get(tab.id)?.webContents.loadURL(tab.pinned.url).catch(() => {})
    }
    if (this.activeTabId === tab.id) {
      const next = this.pickNextTab(tab)
      if (next) this.activateTab(next.id)
      else this.clearActiveTab()
    }
    this.broadcast()
  }

  private middleClick(id: string): void {
    const tab = this.tab(id)
    if (!tab) return
    if (tab.kind === 'normal') return this.closeTab(id)
    if (tab.kind === 'pinned' && !tab.loaded) return this.removeTab(tab)
    this.unloadPinned(tab, true)
  }

  private removeTab(tab: Tab): void {
    const wasActive = this.activeTabId === tab.id
    // Closing a pane keeps the rest of its split on screen.
    const splitSibling = this.splitOf(tab.id)?.tabIds.find((id) => id !== tab.id)
    this.leaveSplit(tab.id)
    const next = wasActive ? (this.tab(splitSibling) ?? this.pickNextTab(tab)) : undefined
    this.destroyView(tab)
    this.tabs = this.tabs.filter((t) => t !== tab)
    this.openers.delete(tab.id)
    for (const space of this.spaces) if (space.lastTabId === tab.id) space.lastTabId = null
    if (wasActive) {
      if (next) this.activateTab(next.id)
      else this.clearActiveTab()
    }
    this.broadcast()
  }

  private unloadPinned(tab: Tab, reset: boolean): void {
    const wasActive = this.activeTabId === tab.id
    const next = wasActive ? this.pickNextTab(tab) : undefined
    this.destroyView(tab)
    if (reset && tab.pinned) Object.assign(tab, tab.pinned)
    if (wasActive) {
      if (next) this.activateTab(next.id)
      else this.clearActiveTab()
    }
    this.broadcast()
  }

  private unload(id: string): void {
    const tab = this.tab(id)
    if (!tab || !tab.loaded) return
    this.unloadPinned(tab, false)
  }

  private resetPinned(id: string, separate: boolean): void {
    const tab = this.tab(id)
    if (!tab?.pinned) return
    if (separate && stripHash(tab.url) !== stripHash(tab.pinned.url)) {
      this.openTab(tab.url, { spaceId: this.activeSpaceId, background: true })
    }
    Object.assign(tab, tab.pinned)
    const view = this.views.get(id)
    if (view) {
      view.webContents
        .loadURL(tab.pinned.url)
        .then(() => view.webContents.navigationHistory.clear())
        .catch(() => {})
    }
    this.activateTab(id)
  }

  private pin(id: string): void {
    const tab = this.tab(id)
    if (!tab || tab.kind !== 'normal') return
    tab.kind = 'pinned'
    tab.pinned = { url: tab.url, title: tab.title, favicon: tab.favicon }
    this.moveToEnd(tab)
    const space = this.space(tab.spaceId ?? '')
    if (space) space.collapsedPins = false
    this.broadcast()
  }

  private unpin(id: string): void {
    const tab = this.tab(id)
    if (!tab || tab.kind !== 'pinned') return
    tab.kind = 'normal'
    tab.pinned = null
    this.moveToFront(tab)
    this.broadcast()
  }

  private addEssential(id: string): void {
    const tab = this.tab(id)
    if (!tab || tab.kind === 'essential') return
    if (this.tabs.filter((t) => t.kind === 'essential').length >= MAX_ESSENTIALS) {
      this.toast({ id: 'essentials-full', message: 'Essentials are full', description: `You can keep up to ${MAX_ESSENTIALS}.` })
      return
    }
    tab.kind = 'essential'
    tab.spaceId = null
    tab.pinned ??= { url: tab.url, title: tab.title, favicon: tab.favicon }
    this.moveToEnd(tab)
    this.broadcast()
  }

  private removeEssential(id: string): void {
    const tab = this.tab(id)
    if (!tab || tab.kind !== 'essential') return
    tab.kind = 'normal'
    tab.spaceId = this.activeSpaceId
    tab.pinned = null
    this.moveToFront(tab)
    this.broadcast()
  }

  private moveTabToSpace(id: string, spaceId: string): void {
    const tab = this.tab(id)
    if (!tab || tab.kind === 'essential') return
    tab.spaceId = spaceId
    if (tab.kind === 'pinned') this.moveToEnd(tab)
    else this.moveToFront(tab)
    this.activateTab(tab.id)
  }

  private moveToEnd(tab: Tab): void {
    this.tabs = [...this.tabs.filter((t) => t !== tab), tab]
  }

  private moveToFront(tab: Tab): void {
    this.tabs = [tab, ...this.tabs.filter((t) => t !== tab)]
  }

  private toggleMute(id: string): void {
    const tab = this.tab(id)
    const wc = this.views.get(id)?.webContents
    if (!tab || !wc) return
    tab.muted = !tab.muted
    wc.setAudioMuted(tab.muted)
    this.broadcast()
  }

  private clearTabs(spaceId: string): void {
    const inSpace = this.tabs.filter((t) => t.kind === 'normal' && t.spaceId === spaceId)
    const safe = inSpace.filter((t) => t.id !== this.activeTabId && !t.audible)
    const closing = safe.length > 0 ? safe : inSpace
    if (closing.length === 0) return
    const batch = ++this.closeBatch
    for (const tab of closing) {
      this.closed.push({ ...tab, batch })
      this.removeTab(tab)
    }
    this.toast({
      id: 'tabs-cleared',
      message: closing.length === 1 ? 'Tab closed' : `${closing.length} tabs closed`,
      description: 'Press ⌘⇧T to bring them back',
      action: { label: 'Undo', command: { type: 'tab.reopenClosed' } },
      timeout: 4000
    })
  }

  private reopenClosed(): void {
    const last = this.closed.at(-1)
    if (!last) return
    const batch = this.closed.filter((c) => c.batch === last.batch)
    this.closed = this.closed.filter((c) => c.batch !== last.batch)
    let reopened: Tab | undefined
    for (const entry of batch.reverse()) {
      const spaceId = this.space(entry.spaceId ?? '') ? entry.spaceId! : this.activeSpaceId
      reopened = makeTab({ kind: 'normal', url: entry.url, title: entry.title, favicon: entry.favicon, spaceId })
      this.insertNormalTab(reopened)
    }
    if (reopened) this.activateTab(reopened.id)
  }

  /** Selects the Nth visible tab (1-based); 9 always means the last one. */
  selectTabIndex(n: number): void {
    const visible = this.visibleTabs()
    const tab = n === 9 ? visible.at(-1) : visible[n - 1]
    if (tab) this.activateTab(tab.id)
  }

  /**
   * ⌃Tab like Arc: jump to the most recently used tab; pressing Tab again
   * while Control is held walks further back. Releasing Control commits.
   */
  cycleRecent(direction: 1 | -1): void {
    if (!this.recentCycle) {
      const order = this.visibleTabs()
        .filter((t) => t.kind === 'normal' || t.loaded)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .map((t) => t.id)
      if (order.length < 2) return
      this.recentCycle = { order, index: 0, timer: null }
    }
    const cycle = this.recentCycle
    cycle.index = (cycle.index + direction + cycle.order.length) % cycle.order.length
    this.activateTab(cycle.order[cycle.index], { keepRecency: true })
    if (cycle.timer) clearTimeout(cycle.timer)
    cycle.timer = setTimeout(() => this.endRecentCycle(), 1500)
  }

  private endRecentCycle(): void {
    const cycle = this.recentCycle
    if (!cycle) return
    if (cycle.timer) clearTimeout(cycle.timer)
    this.recentCycle = null
    const tab = this.tab(this.activeTabId)
    if (tab) tab.lastActiveAt = Date.now()
  }

  /** Releasing Control ends a ⌃Tab cycle, wherever focus is. */
  private watchControlKey(wc: WebContents): void {
    wc.on('before-input-event', (_event, input) => {
      if (input.type === 'keyUp' && input.key === 'Control' && this.recentCycle) this.endRecentCycle()
    })
  }

  /** ⌥1–9: the Nth Essential. */
  selectEssential(n: number): void {
    const tab = this.tabs.filter((t) => t.kind === 'essential')[n - 1]
    if (tab) this.activateTab(tab.id)
  }

  /** ⌘⇧2: screenshot of the visible page, saved to Downloads and copied to the clipboard. */
  async screenshot(): Promise<void> {
    const wc = this.activeWebContents()
    if (!wc) return
    const image = await wc.capturePage()
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const path = uniquePath(join(app.getPath('downloads'), `Zepper Screenshot ${stamp}.png`))
    await writeFile(path, image.toPNG())
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })])
    this.toast({
      id: 'screenshot',
      message: 'Screenshot saved',
      description: 'Copied to clipboard',
      action: { label: 'Show', command: { type: 'download.show', path } },
      timeout: 4000
    })
  }

  cycleTab(delta: number): void {
    const visible = this.visibleTabs()
    if (visible.length === 0) return
    const index = visible.findIndex((t) => t.id === this.activeTabId)
    const next = visible[(index + delta + visible.length) % visible.length]
    this.activateTab(next.id)
  }

  togglePinActive(): void {
    const tab = this.tab(this.activeTabId)
    if (!tab) return
    if (tab.kind === 'normal') this.pin(tab.id)
    else if (tab.kind === 'pinned') this.unpin(tab.id)
  }

  closeActive(): void {
    if (this.activeTabId) this.closeTab(this.activeTabId)
  }

  clearActiveSpace(): void {
    this.clearTabs(this.activeSpaceId)
  }

  reloadActive(hard: boolean): void {
    const wc = this.activeWebContents()
    if (hard) wc?.reloadIgnoringCache()
    else wc?.reload()
  }

  zoomActive(direction: 1 | -1 | 0): void {
    const wc = this.activeWebContents()
    if (!wc) return
    wc.setZoomLevel(direction === 0 ? 0 : wc.getZoomLevel() + direction * 0.5)
  }

  toggleDevTools(): void {
    this.activeWebContents()?.toggleDevTools()
  }

  toggleChromeDevTools(): void {
    this.win.webContents.toggleDevTools()
  }

  // ---------------------------------------------------------------------------
  // Web views

  private ensureView(tab: Tab, adopt?: WebContents): WebContentsView {
    const existing = this.views.get(tab.id)
    if (existing) return existing
    const view = adopt
      ? new WebContentsView({ webContents: adopt })
      : new WebContentsView({
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            session: this.ses,
            scrollBounce: true,
            spellcheck: true
          }
        })
    view.setBorderRadius(this.settings.cornerRadius)
    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff')
    this.views.set(tab.id, view)
    this.tabByWebContents.set(view.webContents.id, tab.id)
    this.wire(tab.id, view.webContents)
    this.extensions?.api.addTab(view.webContents, this.win)
    tab.loaded = true
    if (!adopt) void view.webContents.loadURL(tab.url).catch(() => {})
    return view
  }

  private destroyView(tab: Tab): void {
    if (this.pip?.activeTabId === tab.id) this.pip.exit()
    const view = this.views.get(tab.id)
    tab.loaded = false
    tab.loading = false
    tab.audible = false
    if (!view) return
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(view)
    this.attached.delete(tab.id)
    this.views.delete(tab.id)
    for (const [wcId, id] of this.tabByWebContents) if (id === tab.id) this.tabByWebContents.delete(wcId)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private wire(tabId: string, wc: WebContents): void {
    const update = (patch: Partial<Tab>): void => {
      const tab = this.tab(tabId)
      if (!tab) return
      Object.assign(tab, patch)
      this.broadcast()
    }
    const navState = (): Partial<Tab> => ({
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward()
    })

    this.watchControlKey(wc)
    // Clicking into a split pane makes it the focused (active) tab.
    wc.on('focus', () => {
      if (tabId === this.activeTabId) return
      const split = this.splitOf(tabId)
      if (!split || split !== this.activeSplit()) return
      this.activeTabId = tabId
      const tab = this.tab(tabId)
      if (tab) tab.lastActiveAt = Date.now()
      const space = this.space(this.activeSpaceId)
      if (space) space.lastTabId = tabId
      this.extensions?.api.selectTab(wc)
      this.broadcast()
    })
    // A page with unsaved changes asks before it's left, as in Chrome (Electron would otherwise cancel silently).
    wc.on('will-prevent-unload', (event) => {
      if (this.win.isDestroyed()) return event.preventDefault()
      const choice = dialog.showMessageBoxSync(this.win, {
        type: 'question',
        buttons: ['Leave', 'Stay'],
        defaultId: 0,
        cancelId: 1,
        message: 'Leave site?',
        detail: 'Changes you made may not be saved.'
      })
      if (choice === 0) event.preventDefault()
    })
    wc.on('did-start-loading', () => update({ loading: true }))
    wc.on('did-stop-loading', () => update({ loading: false, ...navState() }))
    wc.on('page-title-updated', (_event, title) => {
      update({ title })
      if (this.tab(tabId)?.media) void this.refreshMedia(tabId, wc)
      if (this.kind !== 'private') this.history.updateTitle(wc.getURL(), title)
    })
    wc.on('page-favicon-updated', (_event, favicons) => update({ favicon: favicons[0] ?? null }))
    wc.on('did-navigate', (_event, url) => {
      update({ url, blockedCount: 0, media: null, ...navState() })
      if (this.kind !== 'private') this.history.record(url, wc.getTitle())
    })
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      update({ url, ...navState() })
      if (this.kind !== 'private') this.history.record(url, wc.getTitle())
    })
    wc.on('audio-state-changed', (event) => {
      update({ audible: event.audible, audibleAt: Date.now() })
      if (event.audible) {
        void this.refreshMedia(tabId, wc)
        this.offerToPauseOthers(tabId)
      }
    })
    wc.on('enter-html-full-screen', () => {
      this.htmlFullscreen = true
      this.layout()
      this.broadcast()
    })
    wc.on('leave-html-full-screen', () => {
      this.htmlFullscreen = false
      this.layout()
      this.broadcast()
    })
    wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      void wc.loadURL(errorPage(url, description)).catch(() => {})
    })
    wc.on('found-in-page', (_event, result) => {
      if (tabId !== this.activeTabId) return
      this.emit({ type: 'find.result', result: { active: result.activeMatchOrdinal, matches: result.matches } }, 'overlay')
    })
    wc.on('context-menu', (_event, params) => this.pageContextMenu(tabId, wc, params))
    wc.setWindowOpenHandler((details) => this.handleWindowOpen(tabId, details))
  }

  private handleWindowOpen(openerId: string, details: HandlerDetails): WindowOpenHandlerResponse {
    // Real popups (OAuth, payment flows) keep their own window so window.opener keeps working.
    if (details.disposition === 'new-window' && details.features) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 700,
          webPreferences: { sandbox: true, contextIsolation: true }
        }
      }
    }
    const opener = this.tab(openerId)
    const spaceId = opener?.kind === 'essential' || !opener?.spaceId ? this.activeSpaceId : opener.spaceId
    return {
      action: 'allow',
      createWindow: (options) => {
        const tab = makeTab({ kind: 'normal', url: details.url, spaceId })
        this.insertNormalTab(tab, opener?.kind === 'normal' ? opener.id : undefined)
        this.openers.set(tab.id, openerId)
        // Electron passes the pre-created guest in `options.webContents`; returning
        // that same WebContents keeps window.opener intact. It's missing from the typings.
        const guest = (options as typeof options & { webContents: WebContents }).webContents
        const view = this.ensureView(tab, guest)
        if (details.disposition === 'background-tab') this.broadcast()
        else this.activateTab(tab.id)
        return view.webContents
      }
    }
  }

  /** Captures now-playing details when a tab starts making sound. */
  private async refreshMedia(tabId: string, wc: WebContents): Promise<void> {
    const tab = this.tab(tabId)
    if (!tab) return
    let meta: { title: string; artist: string; artwork: string | null } | null = null
    try {
      meta = await wc.executeJavaScript(MEDIA_METADATA_SCRIPT, true)
    } catch {
      meta = null
    }
    tab.media = {
      title: meta?.title || tab.title,
      artist: meta?.artist || safeHost(tab.url).replace(/^www\./, ''),
      artwork: meta?.artwork ?? null
    }
    this.broadcast()
  }

  onAdBlocked(webContentsId: number): void {
    const tab = this.tab(this.tabByWebContents.get(webContentsId))
    if (!tab) return
    tab.blockedCount += 1
    // Pages can block dozens of requests a second; refresh the counter a few times a second at most.
    if (this.blockedTimer) return
    this.blockedTimer = setTimeout(() => {
      this.blockedTimer = null
      this.broadcast()
    }, 400)
  }

  // ---------------------------------------------------------------------------
  // Spaces

  private switchSpace(id: string): void {
    if (id === this.activeSpaceId || !this.space(id)) return
    this.activeSpaceId = id
    const space = this.space(id)!
    const remembered = this.tab(space.lastTabId)
    if (remembered && (remembered.kind === 'essential' || remembered.spaceId === id)) {
      this.activateTab(remembered.id)
    } else {
      this.clearActiveTab()
    }
    this.layout()
    this.broadcast()
  }

  switchSpaceRelative(delta: number): void {
    const index = this.spaces.findIndex((s) => s.id === this.activeSpaceId)
    const target = index + delta
    if (!this.settings.wrapSpaces && (target < 0 || target >= this.spaces.length)) return
    const next = this.spaces[(target + this.spaces.length) % this.spaces.length]
    this.switchSpace(next.id)
  }

  switchSpaceIndex(n: number): void {
    const space = this.spaces[n - 1]
    if (space) this.switchSpace(space.id)
  }

  private createSpace(name: string, icon: string, theme: SpaceTheme): void {
    const space = makeSpace(name.trim() || 'Space', icon || '✨', theme)
    const index = this.spaces.findIndex((s) => s.id === this.activeSpaceId)
    this.spaces.splice(index + 1, 0, space)
    this.switchSpace(space.id)
  }

  private updateSpace(id: string, patch: Partial<Pick<Space, 'name' | 'icon' | 'theme' | 'collapsedPins'>>): void {
    const space = this.space(id)
    if (!space) return
    if (patch.name !== undefined) patch.name = patch.name.trim() || space.name
    Object.assign(space, patch)
    this.broadcast()
  }

  private async deleteSpace(id: string): Promise<void> {
    const space = this.space(id)
    if (!space || this.spaces.length <= 1) return
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'warning',
      message: `Delete “${space.name}”?`,
      detail: 'All of its pinned and open tabs will be closed. This can’t be undone.',
      buttons: ['Delete Space', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    if (response !== 0) return
    for (const tab of this.tabs.filter((t) => t.spaceId === id)) {
      this.destroyView(tab)
      this.openers.delete(tab.id)
    }
    this.tabs = this.tabs.filter((t) => t.spaceId !== id)
    if (this.activeTabId && !this.tab(this.activeTabId)) this.activeTabId = null
    const wasActive = this.activeSpaceId === id
    this.spaces = this.spaces.filter((s) => s.id !== id)
    if (wasActive) {
      this.activeSpaceId = '' // forces switchSpace to run
      this.switchSpace(this.spaces[0].id)
    }
    this.broadcast()
  }

  private unloadSpace(id: string): void {
    for (const tab of this.tabs.filter((t) => t.spaceId === id && t.loaded && t.id !== this.activeTabId)) {
      this.destroyView(tab)
    }
    this.broadcast()
  }

  // ---------------------------------------------------------------------------
  // Overlay: command palette, toasts, popovers

  private openPalette(mode: 'new' | 'current' | 'split'): void {
    this.paletteOpen = true
    this.setOverlayMode('full')
    this.overlay.webContents.focus()
    const current = mode === 'current' ? this.tab(this.activeTabId) : undefined
    this.emit({ type: 'palette.open', mode, currentUrl: current?.url ?? null }, 'overlay')
  }

  private closePalette(refocus: boolean): void {
    this.paletteOpen = false
    if (this.showingPrompt !== null) {
      // Dismissing a permission prompt without answering denies it for now.
      const id = this.showingPrompt
      this.showingPrompt = null
      const prompt = this.prompts.find((p) => p.id === id)
      if (prompt) {
        this.prompts = this.prompts.filter((p) => p.id !== id)
        prompt.callback(false)
      }
    }
    if (!refocus) return
    const wc = this.activeWebContents()
    if (wc) wc.focus()
    else this.win.webContents.focus()
  }

  private setOverlayMode(mode: OverlayMode): void {
    if (mode !== 'peek' && this.peeking && mode !== 'hidden') {
      this.peeking = false
      this.win.setWindowButtonVisibility(!this.compact)
    }
    this.overlayMode = mode
    this.layoutOverlay()
  }

  toast(toast: ToastSpec): void {
    this.emit({ type: 'toast', toast }, 'overlay')
  }

  private copyUrl(markdown: boolean): void {
    const tab = this.tab(this.activeTabId)
    if (!tab) return
    const url = stripTracking(tab.url)
    clipboard.writeText(markdown ? `[${tab.title}](${url})` : url)
    this.toast({
      id: 'copy-url',
      message: markdown ? 'Copied as Markdown!' : 'Copied current URL!',
      timeout: 2500
    })
  }

  private toggleCompact(): void {
    this.compact = !this.compact
    this.peeking = false
    if (this.overlayMode === 'peek') this.setOverlayMode('hidden')
    // The traffic lights live in the sidebar; with the sidebar hidden they'd sit on the page.
    this.win.setWindowButtonVisibility(!this.compact)
    this.animateLayout()
    this.broadcast()
  }

  /** Compact mode: float the sidebar over the page while the pointer is at the window edge. */
  private setPeek(show: boolean): void {
    if (!this.compact || !this.settings.compactRevealOnHover) show = false
    if (show === this.peeking) return
    if (show && this.overlayMode === 'full') return
    this.peeking = show
    this.win.setWindowButtonVisibility(show)
    if (show) {
      this.setOverlayMode('peek')
      this.emit({ type: 'peek.show' }, 'overlay')
    } else if (this.overlayMode === 'peek') {
      this.setOverlayMode('hidden')
    }
  }

  // ---------------------------------------------------------------------------
  // Gestures

  /**
   * Two-finger horizontal swipes reported by the page preload. The page slides
   * with the fingers to reveal a back/forward arrow, and navigates once the
   * swipe passes the threshold.
   */
  onPageSwipe(webContentsId: number, phase: 'update' | 'end', dx: number): void {
    const tabId = this.tabByWebContents.get(webContentsId)
    if (!this.settings.swipeToNavigate || tabId !== this.activeTabId || this.htmlFullscreen) return
    const wc = this.activeWebContents()
    if (!wc) return
    const direction = dx < 0 ? 'back' : 'forward'
    const allowed = direction === 'back' ? wc.navigationHistory.canGoBack() : wc.navigationHistory.canGoForward()
    const progress = Math.min(1, Math.abs(dx) / 240)
    if (phase === 'update') {
      const travel = allowed ? 64 * (1 - Math.pow(1 - progress, 3)) : 10 * progress
      this.swipeOffset = direction === 'back' ? travel : -travel
      this.layout()
      this.emit({ type: 'swipe.progress', direction, progress, allowed }, 'chrome')
      return
    }
    if (allowed && progress >= 1) {
      if (direction === 'back') wc.navigationHistory.goBack()
      else wc.navigationHistory.goForward()
    }
    this.emit({ type: 'swipe.progress', direction, progress: 0, allowed }, 'chrome')
    this.animateSwipeBack()
  }

  private animateSwipeBack(): void {
    const from = this.swipeOffset
    const start = Date.now()
    const duration = 220
    const tick = (): void => {
      const t = Math.min(1, (Date.now() - start) / duration)
      this.swipeOffset = from * Math.pow(1 - t, 3)
      this.layout()
      if (t < 1) setTimeout(tick, 8)
    }
    tick()
  }

  /**
   * Animates the web view between the old and new content bounds so layout
   * changes (compact mode, sidebar side, gap) glide instead of jumping. The
   * chrome renderer runs a matching CSS transition.
   */
  private animateLayout(): void {
    const view = this.activeTabId ? this.views.get(this.activeTabId) : undefined
    if (!view || this.settings.reduceMotion || this.attached.size > 1) return this.layout()
    const from = view.getBounds()
    const to = this.contentBounds()
    const start = Date.now()
    const duration = 260
    const ease = (t: number): number => 1 - Math.pow(1 - t, 4)
    if (this.layoutAnimation) clearTimeout(this.layoutAnimation)
    const tick = (): void => {
      const t = Math.min(1, (Date.now() - start) / duration)
      const k = ease(t)
      const lerp = (a: number, b: number): number => Math.round(a + (b - a) * k)
      view.setBounds({ x: lerp(from.x, to.x), y: lerp(from.y, to.y), width: lerp(from.width, to.width), height: lerp(from.height, to.height) })
      if (t < 1) {
        this.layoutAnimation = setTimeout(tick, 8)
      } else {
        this.layoutAnimation = null
        this.layout()
      }
    }
    tick()
    this.layoutOverlay()
  }

  // ---------------------------------------------------------------------------
  // Site info, permissions, find

  /** Cookie-holding domains that belong to the same site (registrable domain) as the page. */
  private async siteData(url: string): Promise<{ domain: string; cookies: number }[]> {
    const site = parseDomain(url).domain
    if (!site) return []
    const counts = new Map<string, number>()
    for (const cookie of await this.ses.cookies.get({})) {
      const domain = (cookie.domain ?? '').replace(/^\./, '')
      if (domain === site || domain.endsWith(`.${site}`)) counts.set(domain, (counts.get(domain) ?? 0) + 1)
    }
    return [...counts.entries()].map(([domain, cookies]) => ({ domain, cookies })).sort((a, b) => a.domain.localeCompare(b.domain))
  }

  private async clearDomain(domain: string): Promise<void> {
    const ses = this.ses
    const cookies = (await ses.cookies.get({})).filter((c) => (c.domain ?? '').replace(/^\./, '') === domain)
    await Promise.all(
      cookies.map((c) => ses.cookies.remove(`http${c.secure ? 's' : ''}://${domain}${c.path ?? '/'}`, c.name).catch(() => {}))
    )
    await Promise.all(['https', 'http'].map((scheme) => ses.clearStorageData({ origin: `${scheme}://${domain}` }).catch(() => {})))
  }

  private siteInfo(): SiteInfo | null {
    const tab = this.tab(this.activeTabId)
    if (!tab) return null
    let parsed: URL | null = null
    try {
      parsed = new URL(tab.url)
    } catch {
      parsed = null
    }
    const host = parsed?.hostname ?? tab.url
    const origin = originOf(tab.url)
    const captured = this.certificates.get(host)
    const https = parsed?.protocol === 'https:'
    return {
      url: tab.url,
      origin,
      host,
      secure: https && (captured?.trusted ?? true),
      insecureReason: https
        ? captured && !captured.trusted
          ? 'The certificate for this site isn’t trusted.'
          : null
        : parsed?.protocol === 'http:'
          ? 'Information you send to this site could be seen by others.'
          : 'This is a local or internal page.',
      certificate: https ? this.certificates.info(host) : null,
      chain: https ? this.certificates.chain(host) : null,
      siteData: [],
      blockedCount: tab.blockedCount,
      adblockEnabled: this.adblock.isEnabled(),
      permissions: /^https?:/.test(tab.url) ? this.permissions.list(origin) : []
    }
  }

  private async openSiteInfo(anchor: Rect): Promise<void> {
    const info = this.siteInfo()
    if (!info) return
    if (/^https?:/.test(info.url)) info.siteData = await this.siteData(info.url)
    this.handle({ type: 'ui.openPopover', popover: { kind: 'siteInfo', anchor, info } })
  }

  private async exportCertificate(index: number): Promise<void> {
    const info = this.siteInfo()
    const pem = info && this.certificates.pem(info.host, index)
    if (!info || !pem) return
    const entry = info.chain?.entries[index]
    const name = (entry?.commonName || info.host).replace(/[^\w.-]+/g, '_')
    const { canceled, filePath } = await dialog.showSaveDialog(this.win, {
      defaultPath: join(app.getPath('downloads'), `${name}.pem`),
      filters: [{ name: 'Certificate', extensions: ['pem', 'crt'] }]
    })
    if (canceled || !filePath) return
    await writeFile(filePath, pem)
    this.toast({ id: 'cert-exported', message: 'Certificate exported', description: basename(filePath) })
  }

  private async clearSiteData(origin: string): Promise<void> {
    await this.ses.clearStorageData({ origin })
    await this.ses.clearCache()
    this.toast({ id: 'site-data-cleared', message: 'Site data cleared', description: safeHost(origin) })
    this.activeWebContents()?.reload()
  }

  /** Shows the oldest pending permission prompt that belongs to the active tab. */
  private showNextPrompt(): void {
    if (this.showingPrompt !== null || this.paletteOpen) return
    const prompt = this.prompts.find((p) => !p.tabId || p.tabId === this.activeTabId)
    if (!prompt) return
    this.showingPrompt = prompt.id
    const bounds = this.contentBounds()
    const anchor = { x: bounds.x + 4, y: bounds.y, width: 0, height: 0 }
    const { keys: _keys, tabId: _tabId, callback: _callback, ...view } = prompt
    this.handle({ type: 'ui.openPopover', popover: { kind: 'permission', anchor, prompt: view } })
  }

  private respondToPrompt(id: number, allow: boolean): void {
    const prompt = this.prompts.find((p) => p.id === id)
    this.prompts = this.prompts.filter((p) => p.id !== id)
    if (this.showingPrompt === id) this.showingPrompt = null
    if (!prompt) return
    const state: PermissionState = allow ? 'allow' : 'block'
    for (const key of prompt.keys) this.permissions.set(prompt.origin, key, state)
    prompt.callback(allow)
    // Resolve other queued requests the decision now covers.
    for (const other of this.prompts.filter((p) => p.origin === prompt.origin && p.keys.every((k) => prompt.keys.includes(k)))) {
      other.callback(allow)
    }
    this.prompts = this.prompts.filter((p) => !(p.origin === prompt.origin && p.keys.every((k) => prompt.keys.includes(k))))
    setTimeout(() => this.showNextPrompt(), 200)
  }

  private dropPrompts(match: (prompt: PendingPrompt) => boolean): void {
    for (const prompt of this.prompts.filter(match)) prompt.callback(false)
    this.prompts = this.prompts.filter((p) => !match(p))
  }

  openFind(): void {
    if (!this.activeWebContents()) return
    this.emit({ type: 'find.open' }, 'overlay')
    this.setOverlayMode('corner')
    this.overlay.webContents.focus()
  }

  findAgain(forward: boolean): void {
    if (this.lastFindText) this.find(this.lastFindText, forward, true)
  }

  private find(text: string, forward: boolean, findNext: boolean): void {
    const wc = this.activeWebContents()
    if (!wc) return
    this.lastFindText = text
    if (!text) {
      wc.stopFindInPage('clearSelection')
      this.emit({ type: 'find.result', result: { active: 0, matches: 0 } }, 'overlay')
      return
    }
    wc.findInPage(text, { forward, findNext })
  }

  // ---------------------------------------------------------------------------
  // Menus

  private popup(items: (MenuItemConstructorOptions | Electron.MenuItem)[], anchor?: Rect): void {
    const menu = Menu.buildFromTemplate(items)
    if (anchor) {
      menu.popup({ window: this.win, x: Math.round(anchor.x), y: Math.round(anchor.y + anchor.height + 4) })
    } else {
      menu.popup({ window: this.win })
    }
  }

  private tabContextMenu(id: string): void {
    const tab = this.tab(id)
    if (!tab) return
    const essentialsFull = this.tabs.filter((t) => t.kind === 'essential').length >= MAX_ESSENTIALS
    const changed = !!tab.pinned && stripHash(tab.url) !== stripHash(tab.pinned.url)
    const otherSpaces = this.spaces.filter((s) => s.id !== tab.spaceId)
    const items: MenuItemConstructorOptions[] = []

    if (tab.loaded) items.push({ label: 'Reload Tab', click: () => this.views.get(id)?.webContents.reload() })
    items.push(
      { label: 'Duplicate Tab', click: () => this.openTab(tab.url, { afterTabId: tab.id }) },
      { label: 'Copy Link', click: () => clipboard.writeText(stripTracking(tab.url)) },
      { type: 'separator' }
    )
    if (tab.kind === 'normal') items.push({ label: 'Pin Tab', click: () => this.pin(id) })
    if (tab.kind === 'pinned') items.push({ label: 'Unpin Tab', click: () => this.unpin(id) })
    if (tab.kind === 'essential') {
      items.push({ label: 'Remove from Essentials', click: () => this.removeEssential(id) })
    } else {
      items.push({ label: 'Add to Essentials', enabled: !essentialsFull, click: () => this.addEssential(id) })
    }
    if (tab.pinned) {
      const noun = tab.kind === 'essential' ? 'Essential' : 'Pinned Tab'
      items.push(
        { label: `Reset ${noun}`, enabled: changed, click: () => this.resetPinned(id, false) },
        {
          label: 'Replace Pinned URL with Current',
          enabled: changed,
          click: () => {
            tab.pinned = { url: tab.url, title: tab.title, favicon: tab.favicon }
            this.broadcast()
            this.toast({ id: 'pin-replaced', message: 'Pinned URL updated!' })
          }
        }
      )
    }
    const split = this.splitOf(id)
    const active = this.tab(this.activeTabId)
    if (split) {
      items.push(
        { type: 'separator' },
        {
          label: 'Split Layout',
          submenu: (
            [
              ['horizontal', 'Side by Side'],
              ['vertical', 'Stacked'],
              ['grid', 'Grid']
            ] as [SplitLayout, string][]
          ).map(([layout, label]) => ({
            label,
            type: 'radio' as const,
            checked: split.layout === layout,
            click: () => this.handle({ type: 'split.layout', splitId: split.id, layout })
          }))
        },
        { label: 'Remove from Split View', click: () => this.removeFromSplit(id) },
        { label: 'Unsplit All', click: () => this.dissolveSplit(split.id) }
      )
    } else if (tab.kind !== 'essential' && active && active.id !== id && active.kind !== 'essential') {
      items.push({ type: 'separator' }, { label: 'Split View with Current Tab', click: () => this.addToSplit(id) })
    }
    if (tab.kind !== 'essential' && otherSpaces.length > 0) {
      items.push({
        label: 'Move to Space',
        submenu: otherSpaces.map((s) => ({ label: `${s.icon}  ${s.name}`, click: () => this.moveTabToSpace(id, s.id) }))
      })
    }
    items.push({ type: 'separator' })
    if (tab.audible || tab.muted) {
      items.push({ label: tab.muted ? 'Unmute Tab' : 'Mute Tab', click: () => this.toggleMute(id) })
    }
    if (tab.loaded) items.push({ label: 'Unload Tab', click: () => this.unload(id) })
    if (tab.kind !== 'essential') {
      items.push({ label: 'Close Tab', click: () => (tab.kind === 'normal' ? this.closeTab(id) : this.removeTab(tab)) })
    }
    this.popup(items)
  }

  private spaceContextMenu(id: string, anchor: Rect): void {
    const space = this.space(id)
    if (!space) return
    this.popup([
      { label: 'Rename Space', click: () => this.emit({ type: 'space.startRename', spaceId: id }, 'chrome') },
      { label: 'Change Icon…', click: () => this.handle({ type: 'ui.openPopover', popover: { kind: 'emoji', spaceId: id, anchor } }) },
      { label: 'Edit Theme…', click: () => this.handle({ type: 'ui.openPopover', popover: { kind: 'theme', spaceId: id, anchor } }) },
      { type: 'separator' },
      { label: 'Unload Space', click: () => this.unloadSpace(id) },
      { type: 'separator' },
      { label: 'Create Space', click: () => this.handle({ type: 'ui.createSpace' }) },
      { label: 'Delete Space', enabled: this.spaces.length > 1, click: () => void this.deleteSpace(id) }
    ])
  }

  private newMenu(anchor: Rect): void {
    this.popup(
      [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => this.openPalette('new') },
        { label: 'Create Space', click: () => this.handle({ type: 'ui.createSpace' }) }
      ],
      anchor
    )
  }

  private settingsMenu(anchor: Rect): void {
    this.popup(
      [
        {
          label: 'Block Ads and Trackers',
          type: 'checkbox',
          checked: this.settings.adblock,
          click: () => this.settingsStore.update({ adblock: !this.settings.adblock })
        },
        { label: 'Compact Mode', type: 'checkbox', checked: this.compact, accelerator: 'CmdOrCtrl+S', click: () => this.toggleCompact() },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => this.handle({ type: 'ui.openSettings' }) }
      ],
      anchor
    )
  }

  private pageContextMenu(tabId: string, wc: WebContents, params: ContextMenuParams): void {
    const items: (MenuItemConstructorOptions | Electron.MenuItem)[] = []
    const tab = this.tab(tabId)

    for (const suggestion of params.dictionarySuggestions.slice(0, 4)) {
      items.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) })
    }
    if (params.dictionarySuggestions.length > 0) items.push({ type: 'separator' })

    if (params.linkURL) {
      items.push(
        {
          label: 'Open Link in New Tab',
          click: () => this.openTab(params.linkURL, { background: true, spaceId: tab?.spaceId ?? undefined, afterTabId: tabId })
        },
        {
          label: 'Open Link in Split View',
          click: () => {
            this.activateTab(tabId)
            this.openInput(params.linkURL, 'split')
          }
        },
        { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      )
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push(
        { label: 'Open Image in New Tab', click: () => this.openTab(params.srcURL, { background: true }) },
        { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
        { label: 'Save Image As…', click: () => wc.downloadURL(params.srcURL) },
        { type: 'separator' }
      )
    }
    if (params.isEditable) {
      items.push(
        { role: 'undo', enabled: params.editFlags.canUndo },
        { role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { role: 'selectAll' },
        { type: 'separator' }
      )
    } else if (params.selectionText.trim()) {
      const text = params.selectionText.trim()
      const short = text.length > 24 ? `${text.slice(0, 24)}…` : text
      items.push(
        { role: 'copy' },
        { label: `Search Google for “${short}”`, click: () => this.openTab(searchUrl(text), { afterTabId: tabId }) },
        { type: 'separator' }
      )
    }
    if (!params.linkURL && !params.isEditable && !params.selectionText.trim() && params.mediaType === 'none') {
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' }
      )
    }
    const extensionItems = this.extensions?.api.getContextMenuItems(wc, params) ?? []
    if (extensionItems.length > 0) items.push(...extensionItems, { type: 'separator' })
    items.push({ label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) })
    this.popup(items)
  }

  // ---------------------------------------------------------------------------
  // Layout, snapshots, persistence

  private contentBounds(): Rectangle {
    const [width, height] = this.win.getContentSize()
    if (this.htmlFullscreen) return { x: 0, y: 0, width, height }
    const gap = this.settings.contentGap
    const sidebar = this.compact ? gap : this.sidebarWidth
    const right = this.settings.sidebarPosition === 'right'
    // With the sidebar on the right, the traffic lights need a strip above the page.
    const top = right && !this.compact ? Math.max(gap, TITLEBAR_STRIP) : gap
    return {
      x: right ? gap : sidebar,
      y: top,
      width: Math.max(0, width - sidebar - gap),
      height: Math.max(0, height - top - gap)
    }
  }

  private layout(): void {
    if (!this.win || this.win.isDestroyed()) return
    if (!this.layoutAnimation) {
      for (const pane of this.panes()) {
        const view = this.views.get(pane.tabId)
        if (!view) continue
        const hidden = this.htmlFullscreen && pane.tabId !== this.activeTabId
        view.setVisible(!hidden)
        if (hidden) continue
        const single = this.attached.size <= 1
        view.setBounds({ ...pane.rect, x: pane.rect.x + (single ? Math.round(this.swipeOffset) : 0) })
        view.setBorderRadius(this.htmlFullscreen ? 0 : this.settings.cornerRadius)
      }
    }
    this.layoutOverlay()
  }

  // ---------------------------------------------------------------------------
  // Split view

  private splitOf(tabId: string | null | undefined): Split | undefined {
    return tabId ? this.splits.find((split) => split.tabIds.includes(tabId)) : undefined
  }

  private activeSplit(): Split | undefined {
    return this.splitOf(this.activeTabId)
  }

  /** Where each visible view goes: the whole content area, or one pane per split tab. */
  private panes(): Pane[] {
    const bounds = this.contentBounds()
    const split = this.activeSplit()
    if (!split || this.htmlFullscreen) {
      return this.activeTabId ? [{ tabId: this.activeTabId, rect: bounds }] : []
    }
    const rects = splitRects(split, bounds, Math.max(6, this.settings.contentGap))
    return split.tabIds.map((tabId, i) => ({ tabId, rect: rects[i] }))
  }

  /** Attaches exactly the views that should be on screen, keeping the overlay on top. */
  private syncAttachedViews(): void {
    const wanted = new Set(this.activeSplit()?.tabIds ?? (this.activeTabId ? [this.activeTabId] : []))
    for (const id of [...this.attached]) {
      if (wanted.has(id)) continue
      const view = this.views.get(id)
      if (view) this.win.contentView.removeChildView(view)
      this.attached.delete(id)
    }
    if (this.pip?.activeTabId && wanted.has(this.pip.activeTabId)) this.pip.exit()
    for (const id of wanted) {
      const tab = this.tab(id)
      if (!tab) continue
      this.win.contentView.addChildView(this.ensureView(tab))
      this.attached.add(id)
    }
    this.win.contentView.addChildView(this.overlay)
    this.layout()
  }

  /** Adds a tab to the active tab's split, or starts a split with the active tab. */
  private addToSplit(tabId: string): void {
    const active = this.tab(this.activeTabId)
    const tab = this.tab(tabId)
    if (!active || !tab || tab.id === active.id || tab.kind === 'essential' || active.kind === 'essential') {
      if (tab) this.activateTab(tab.id)
      return
    }
    this.leaveSplit(tab.id)
    let split = this.activeSplit()
    if (split && split.tabIds.length >= MAX_SPLIT_PANES) {
      this.toast({ id: 'split-full', message: 'Split view is full', description: `Up to ${MAX_SPLIT_PANES} tabs can be split.` })
      return
    }
    if (!split) {
      split = { id: randomUUID(), tabIds: [active.id], layout: 'horizontal', sizes: [1] }
      this.splits.push(split)
    }
    split.tabIds.push(tab.id)
    split.sizes = evenSizes(split.layout === 'grid' ? 1 : split.tabIds.length)
    if (tab.spaceId !== active.spaceId && active.spaceId) tab.spaceId = active.spaceId
    this.activateTab(tab.id)
  }

  private leaveSplit(tabId: string): void {
    const split = this.splitOf(tabId)
    if (!split) return
    split.tabIds = split.tabIds.filter((id) => id !== tabId)
    if (split.tabIds.length < 2) this.splits = this.splits.filter((x) => x !== split)
    else split.sizes = evenSizes(split.layout === 'grid' ? 1 : split.tabIds.length)
  }

  private removeFromSplit(tabId: string): void {
    this.leaveSplit(tabId)
    this.activateTab(tabId)
  }

  private dissolveSplit(splitId: string): void {
    this.splits = this.splits.filter((x) => x.id !== splitId)
    if (this.activeTabId) this.activateTab(this.activeTabId)
  }

  /** ⌥⌘V / ⌥⌘H / ⌥⌘G: change the split layout, or split the current tab with the next one. */
  splitWithLayout(layout: SplitLayout): void {
    const split = this.activeSplit()
    if (split) return this.handle({ type: 'split.layout', splitId: split.id, layout })
    const visible = this.visibleTabs().filter((t) => t.kind !== 'essential')
    const index = visible.findIndex((t) => t.id === this.activeTabId)
    const partner = visible[index + 1] ?? visible[index - 1]
    if (!partner) {
      this.toast({ id: 'split-none', message: 'Open another tab to split with' })
      return
    }
    this.addToSplit(partner.id)
    const created = this.activeSplit()
    if (created) this.handle({ type: 'split.layout', splitId: created.id, layout })
  }

  /** ⌃⇧=: open the command bar to pick a page for a new split pane. */
  addSplitPane(): void {
    if (!this.activeTabId) return this.openPalette('new')
    this.openPalette('split')
  }

  /** ⌃⇧−: take the focused tab out of its split. */
  removeSplitPane(): void {
    if (this.activeTabId && this.activeSplit()) this.removeFromSplit(this.activeTabId)
  }

  dissolveActiveSplit(): void {
    const split = this.activeSplit()
    if (split) this.dissolveSplit(split.id)
  }

  private layoutOverlay(): void {
    if (!this.overlay) return
    const [width, height] = this.win.getContentSize()
    if (this.overlayMode === 'hidden') {
      this.overlay.setVisible(false)
      return
    }
    this.overlay.setVisible(true)
    const peekWidth = this.sidebarWidth + 24
    const right = this.settings.sidebarPosition === 'right'
    this.overlay.setBounds(
      this.overlayMode === 'full'
        ? { x: 0, y: 0, width, height }
        : this.overlayMode === 'peek'
          ? { x: right ? width - peekWidth : 0, y: 0, width: peekWidth, height }
          : { x: width - CORNER_REGION.width, y: 0, ...CORNER_REGION }
    )
  }

  private windowBounds(): Rect {
    const [width, height] = this.win.getContentSize()
    return { x: 0, y: 0, width, height }
  }

  private snapshot(): Snapshot {
    return {
      spaces: this.spaces,
      tabs: this.tabs,
      activeSpaceId: this.activeSpaceId,
      activeTabId: this.activeTabId,
      sidebarWidth: this.sidebarWidth,
      compact: this.compact,
      focused: this.win?.isFocused() ?? true,
      fullscreen: this.htmlFullscreen,
      adblockEnabled: this.adblock.isEnabled(),
      settings: this.settings,
      kind: this.kind,
      splits: this.splits,
      panes: this.win && !this.win.isDestroyed() ? this.panes() : []
    }
  }

  /** Coalesces state changes into at most one snapshot per frame for both renderers. */
  private broadcast(): void {
    if (this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      if (this.windowClosed || this.win.isDestroyed()) return
      const snapshot = this.snapshot()
      this.win.webContents.send(IPC.snapshot, snapshot)
      this.overlay.webContents.send(IPC.snapshot, snapshot)
      this.pip?.controlsWebContents()?.send(IPC.snapshot, snapshot)
      this.stateFile?.schedule(this.persistedState())
    }, 16)
  }

  private emit(event: UiEvent, target: 'chrome' | 'overlay'): void {
    const wc = target === 'chrome' ? this.win.webContents : this.overlay.webContents
    wc.send(IPC.event, event)
  }

  private persistedState(): PersistedState {
    return {
      version: 1,
      spaces: this.spaces,
      tabs: this.tabs.map(({ id, kind, spaceId, url, title, favicon, pinned, lastActiveAt }) => ({
        id,
        kind,
        spaceId,
        url,
        title,
        favicon,
        pinned,
        lastActiveAt
      })),
      activeSpaceId: this.activeSpaceId,
      activeTabId: this.activeTabId,
      sidebarWidth: this.sidebarWidth,
      compact: this.compact,
      adblockEnabled: this.settings.adblock,
      splits: this.splits
    }
  }
}

function evenSizes(n: number): number[] {
  return n <= 1 ? [0.5] : Array.from({ length: n }, () => 1 / n)
}

/**
 * Pane rectangles for a split. Horizontal = side by side, vertical = stacked,
 * grid = Zen's 3 (A over B | C) and 4 (2×2) layouts.
 */
function splitRects(split: Split, b: Rectangle, gap: number): Rectangle[] {
  const n = split.tabIds.length
  if (split.layout === 'grid' && n >= 3) {
    const leftW = Math.round((b.width - gap) * Math.min(0.8, Math.max(0.2, split.sizes[0] ?? 0.5)))
    const rightX = b.x + leftW + gap
    const rightW = b.width - leftW - gap
    const topH = Math.round((b.height - gap) / 2)
    const bottomY = b.y + topH + gap
    const bottomH = b.height - topH - gap
    const rects = [
      { x: b.x, y: b.y, width: leftW, height: topH },
      { x: b.x, y: bottomY, width: leftW, height: bottomH }
    ]
    if (n === 3) rects.push({ x: rightX, y: b.y, width: rightW, height: b.height })
    else rects.push({ x: rightX, y: b.y, width: rightW, height: topH }, { x: rightX, y: bottomY, width: rightW, height: bottomH })
    return rects
  }
  const vertical = split.layout === 'vertical'
  const total = (vertical ? b.height : b.width) - gap * (n - 1)
  const raw = split.sizes.length === n ? split.sizes : evenSizes(n)
  const sum = raw.reduce((a, c) => a + c, 0) || 1
  const rects: Rectangle[] = []
  let offset = 0
  raw.forEach((fraction, i) => {
    const length = i === n - 1 ? total - offset : Math.round((total * fraction) / sum)
    const start = offset + i * gap
    rects.push(vertical ? { x: b.x, y: b.y + start, width: b.width, height: length } : { x: b.x + start, y: b.y, width: length, height: b.height })
    offset += length
  })
  return rects
}

/** Appends " (1)", " (2)"… so downloads never overwrite an existing file. */
function uniquePath(path: string): string {
  if (!existsSync(path)) return path
  const ext = extname(path)
  const stem = path.slice(0, path.length - ext.length)
  for (let i = 1; ; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!existsSync(candidate)) return candidate
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function errorPage(url: string, description: string): string {
  const escape = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
  const html = `<!doctype html><meta charset="utf-8"><title>Can’t reach this page</title>
<style>
  :root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: light-dark(#fafafa, #1c1c1e); color: light-dark(#333, #ddd); }
  main { max-width: 440px; padding: 24px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0 0 6px; opacity: .7; line-height: 1.5; word-break: break-all; }
  code { font-size: 12px; opacity: .6; }
</style>
<main><h1>Can’t reach this page</h1><p>${escape(url)}</p><code>${escape(description)}</code></main>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
