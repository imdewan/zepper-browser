import {
  BrowserWindow,
  ClipboardItem,
  Menu,
  WebContentsView,
  app,
  clipboard,
  dialog,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell,
  systemPreferences,
  type AuthInfo,
  type Certificate,
  type ContextMenuParams,
  type DownloadItem,
  type IpcMainEvent,
  type PermissionCheckHandlerHandlerDetails,
  type Session,
  type HandlerDetails,
  type MenuItemConstructorOptions,
  type Rectangle,
  type WebContents,
  type WindowOpenHandlerResponse
} from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PEEK_AREA_EXTRA, PIP_WIDTH, PROTECTIONS, type Protection, type Settings } from '@shared/settings'
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
  type AuthSpec,
  type DropTarget,
  type Folder,
  type IntelligenceStatus,
  type JsDialogSpec,
  type PopoverSpec,
  type ProfileChoice,
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
import { AutofillController, type PageMessage } from './autofill'
import { startDebugServer } from './devtools-server'
import { JsonFile } from './persist'
import { parse as parseDomain } from 'tldts-experimental'
import { SitePermissions, originOf, promptLabel, settingKeys } from './site'
import { suggest } from './suggest'
import { BROWSING_PARTITION } from './extensions'
import { tidyGroups } from './tidy'
import { AiError, intelligence } from './ai'
import { resolveInput, searchEngineName, searchUrl, setSearchEngine, stripHash, stripTracking } from './url'
import { nextZoom } from './zoom'
import { CAPTURE_TARGETS_SCRIPT, captureArea, captureFullPage, pngWithDensity, type CaptureTargets } from './capture'

/** Height reserved for the traffic lights when the sidebar is on the right. */
const TITLEBAR_STRIP = 34
/** Where the traffic lights sit in the sidebar's top row. */
const TRAFFIC_LIGHTS = { x: 17, y: 17 }
/** The compact-mode peek card's inset from the window edge (overlay.css .peek-card). */
const PEEK_INSET = 6
const MIN_SIDEBAR = 190
const MAX_SIDEBAR = 500
const DEFAULT_SIDEBAR = 250
const MAX_ESSENTIALS = 12
/** Top-right overlay region for toasts and the find bar. */
const CORNER_REGION = { width: 440, height: 240 }

type PersistedTab = Pick<Tab, 'id' | 'kind' | 'spaceId' | 'url' | 'title' | 'favicon' | 'pinned' | 'lastActiveAt'>

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
  folders?: Folder[]
  /** The main window's size and place (its normal, un-maximized bounds). */
  window?: { bounds: Rectangle; maximized: boolean }
}

const MAX_SPLIT_PANES = 4
/** How long a click or key press lets a page open a tab or popup (Chrome's user activation). */
const USER_ACTIVATION_MS = 5000
const USER_INPUT = new Set(['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'char', 'gestureTap', 'touchStart'])

interface PendingPrompt extends PermissionPrompt {
  keys: string[]
  tabId: string | undefined
  /** The page that asked; its prompts go when it does. */
  webContentsId: number
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
    language: null,
    translation: null,
    ...fields
  }
}

/** Reads the page's Media Session metadata (title, artist, artwork) if it publishes any. */
const MEDIA_REFRESH_MS = 3000
/** Closed tabs remembered for Reopen Closed Tab. */
const MAX_CLOSED = 50
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

/** Finger travel (trackpad px, momentum excluded) that navigates back or forward. */
const SWIPE_DISTANCE = 170
/** A quick flick navigates with less travel. */
const FLICK_DISTANCE = 70
const FLICK_SPEED = 24

/** macOS natural scrolling (on unless explicitly turned off); re-read at most every 30s. */
let naturalScrolling = true
let naturalScrollingReadAt = 0
function readNaturalScrolling(): void {
  if (process.platform !== 'darwin' || Date.now() - naturalScrollingReadAt < 30_000) return
  naturalScrollingReadAt = Date.now()
  execFile('defaults', ['read', '-g', 'com.apple.swipescrolldirection'], (error, stdout) => {
    naturalScrolling = error ? true : stdout.trim() !== '0'
  })
}

/** Narrowest strip compact mode leaves at the sidebar's edge, so hovering there can reveal it. */
const MIN_REVEAL_EDGE = 4

/** How long a playing tab must stay out of view before its video floats. */
const PIP_DELAY_MS = 250

/** Skips the floating (or playing, or first) video/audio element by some seconds; true when it found one. */
function mediaSeekScript(seconds: number): string {
  return `(() => {
  const media = Array.from(document.querySelectorAll('video, audio'))
  const el = document.querySelector('video[data-zepper-pip]') || media.find((m) => !m.paused) || media[0]
  if (!el) return false
  const end = Number.isFinite(el.duration) ? el.duration - 0.25 : Infinity
  el.currentTime = Math.max(0, Math.min(end, el.currentTime + ${seconds}))
  return true
})()`
}

/** An isolated JavaScript world for Zepper's own reads of a page (the page can't see or change it). */
const ZEPPER_WORLD = 1001

/** The readable text of a page: its article or main content when it marks one, else the whole body. */
const PAGE_TEXT_SCRIPT = `(() => {
  const root = document.querySelector('article') || document.querySelector('main, [role="main"]') || document.body
  const text = (root ? root.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 60000)
  const description = document.querySelector('meta[name="description"], meta[property="og:description"]')?.content || ''
  return { title: document.title, text: description && !text.includes(description) ? description + '\\n\\n' + text : text }
})()`

/**
 * In-page translation (in Zepper's isolated world). Text is translated a paragraph at a time
 * (headings, list items, cells…), each text node a tagged segment, so links and formatting
 * survive: in place when the translation keeps the word order, else the paragraph's inline
 * markup is rebuilt in the new order. Visible paragraphs go first; text added later joins the
 * queue; the original comes back exactly.
 */
const TRANSLATOR_SCRIPT = `(() => {
  if (window.__zepperTranslator) return true
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'KBD', 'SAMP', 'VAR', 'SVG', 'MATH', 'INPUT', 'SELECT', 'OPTION', 'TEMPLATE'])
  const BLOCK = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'DT', 'DD', 'BLOCKQUOTE', 'FIGCAPTION', 'CAPTION', 'LEGEND', 'SUMMARY', 'BUTTON', 'LABEL', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'MAIN', 'FORM', 'TABLE', 'TR', 'UL', 'OL', 'DL', 'BODY'])
  const INLINE = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'DATA', 'DFN', 'EM', 'FONT', 'I', 'IMG', 'INS', 'DEL', 'MARK', 'Q', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'WBR'])
  const units = []
  const unitOf = new Map()
  const seen = new WeakSet()
  let added = []
  let observer = null
  const accept = (node) => {
    if (seen.has(node) || !/\\p{L}/u.test(node.nodeValue || '')) return false
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (SKIP.has(el.tagName) || el.isContentEditable || el.getAttribute('translate') === 'no' || el.classList.contains('notranslate')) return false
    }
    return true
  }
  const blockOf = (node) => {
    let el = node.parentElement
    while (el && !BLOCK.has(el.tagName)) el = el.parentElement
    return el || document.body
  }
  const take = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node && units.length < 12000; node = walker.nextNode()) {
      if (!accept(node)) continue
      seen.add(node)
      const block = blockOf(node)
      let unit = unitOf.get(block)
      if (!unit || unit.state !== 0) {
        unit = { block, nodes: [], original: [], state: 0, saved: null, shared: !!unit }
        unitOf.set(block, unit)
        units.push(unit)
      }
      unit.nodes.push(node)
      unit.original.push(node.nodeValue)
    }
  }
  const plain = (unit) => {
    if (unit.shared) return false
    for (const el of unit.block.querySelectorAll('*')) if (!INLINE.has(el.tagName)) return false
    return true
  }
  window.__zepperTranslator = {
    collect: () => (take(document.body), units.length),
    next: (maxUnits, maxChars) => {
      const height = innerHeight
      const waiting = []
      units.forEach((unit, u) => {
        if (unit.state !== 0 || !unit.block.isConnected) return
        const box = unit.block.getBoundingClientRect()
        if (box.width === 0 && box.height === 0) return
        const size = unit.nodes.reduce((n, node) => n + node.nodeValue.length, 0)
        waiting.push([u, box.bottom < 0 ? -box.bottom + height : box.top > height ? box.top - height : 0, size])
      })
      // On screen, the longest paragraphs first (that's the reading, not the menus); off screen, nearest first.
      waiting.sort((a, b) => a[1] - b[1] || b[2] - a[2])
      const batch = []
      let chars = 0
      for (const [u] of waiting) {
        const segments = units[u].nodes.map((node) => node.nodeValue)
        const size = segments.join('').length
        if (batch.length >= maxUnits || (batch.length > 0 && chars + size > maxChars)) break
        units[u].state = 1
        chars += size
        batch.push({ u, segments })
      }
      return batch
    },
    apply: (results) => {
      for (const [u, runs] of results) {
        const unit = units[u]
        if (!unit) continue
        unit.state = 2
        const pieces = []
        for (const [k, text] of runs) {
          const segment = k >= 0 && k < unit.nodes.length ? k : pieces.length ? pieces[pieces.length - 1][0] : 0
          if (pieces.length && pieces[pieces.length - 1][0] === segment) pieces[pieces.length - 1][1] += text
          else pieces.push([segment, text])
        }
        const inOrder = pieces.every((piece, i) => i === 0 || piece[0] > pieces[i - 1][0])
        if (inOrder) {
          // Same order: each text node gets its piece (with the translation's own spacing).
          const texts = unit.nodes.map(() => '')
          for (const [k, text] of pieces) texts[k] = text
          unit.nodes.forEach((node, k) => node.isConnected && (node.nodeValue = texts[k]))
          continue
        }
        if (!plain(unit)) {
          // Reordered, with more than links and formatting inside: the whole sentence goes in the
          // first text node, so it reads right (links in it lose their text).
          unit.nodes.forEach((node, k) => node.isConnected && (node.nodeValue = k === 0 ? pieces.map((piece) => piece[1]).join('') : ''))
          continue
        }
        unit.saved = [...unit.block.childNodes]
        const fragment = document.createDocumentFragment()
        for (const [k, text] of pieces) {
          let piece = document.createTextNode(text)
          for (let el = unit.nodes[k].parentElement; el && el !== unit.block; el = el.parentElement) {
            const wrapper = el.cloneNode(false)
            wrapper.appendChild(piece)
            piece = wrapper
          }
          fragment.appendChild(piece)
        }
        unit.block.replaceChildren(fragment)
      }
    },
    watch: () => {
      observer = observer || new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) added.push(node)
      })
      observer.observe(document.body, { childList: true, subtree: true })
    },
    collectAdded: () => {
      const roots = added.filter((node) => node.isConnected)
      added = []
      for (const root of roots) if (root.nodeType === 1) take(root)
      else if (root.nodeType === 3 && root.parentElement) take(root.parentElement)
    },
    restore: () => {
      observer?.disconnect()
      observer = null
      added = []
      for (const unit of units) {
        if (unit.saved) unit.block.replaceChildren(...unit.saved)
        else if (unit.state === 2) unit.nodes.forEach((node, k) => node.isConnected && (node.nodeValue = unit.original[k]))
        unit.saved = null
        unit.state = 0
      }
    }
  }
  return true
})()`

/** The page's declared language, and a sample of its text to check. */
const LANGUAGE_SCRIPT = `({ lang: document.documentElement.lang || '', sample: (document.body ? document.body.innerText : '').slice(0, 800) })`

/** Pauses every playing video and audio element. */
const MEDIA_PAUSE_SCRIPT = `(() => {
  document.querySelectorAll('video, audio').forEach((el) => { if (!el.paused) el.pause() })
})()`

/** Pauses whatever is playing in a frame (remembering it); 'paused' if anything was. */
const MEDIA_PAUSE_PLAYING_SCRIPT = `(() => {
  const playing = Array.from(document.querySelectorAll('video, audio')).filter((el) => !el.paused)
  if (!playing.length) return 'idle'
  playing.forEach((el) => el.pause())
  window.__zepperPaused = playing
  return 'paused'
})()`

/** Resumes what we paused last time in a frame (or its first media element); 'playing' if it did. */
const MEDIA_RESUME_SCRIPT = `(() => {
  const media = Array.from(document.querySelectorAll('video, audio'))
  const resume = (window.__zepperPaused || media).filter((el) => el.isConnected)
  if (!resume[0]) return 'none'
  resume[0].play()
  return 'playing'
})()`

/** The profile Essentials, extensions and your first space use (Electron's default session). */
export const DEFAULT_PROFILE = 'default'

/** New spaces get their own profile: separate cookies, logins, storage and cache. */
function makeSpace(name: string, icon: string, theme: SpaceTheme = DEFAULT_THEME, profile: string = randomUUID()): Space {
  return { id: randomUUID(), name, icon, theme, collapsedPins: false, lastTabId: null, profile, pinnedItems: [] }
}

/**
 * Owns all browser state for the window: spaces, tabs (Essentials, pinned and
 * normal), the web views behind them, and the overlay used for the command
 * palette, toasts and popovers. Renderers only display snapshots of this
 * state and send commands back.
 */
/** main: the persistent window; blank: temporary tabs, shared sign-ins; private: throwaway session. */
export type BrowserKind = 'main' | 'blank' | 'private'

/**
 * What a new window starts from: the size and sidebar of the window you were in and,
 * optionally, its current space (name, look and sign-ins) with no tabs.
 */
export interface WindowSeed {
  bounds: Rectangle
  sidebarWidth: number
  compact: boolean
  space?: Space
}

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
  private savedWindow: PersistedState['window'] = undefined
  private readonly permissions: SitePermissions
  private prompts: PendingPrompt[] = []
  private promptSeq = 0
  private showingPrompt: number | null = null
  private lastFindText = ''
  private peeking = false
  /** The corner region's size: just what the overlay shows there (it would swallow clicks on the page). */
  private cornerSize = { ...CORNER_REGION }
  /** The mode the overlay itself last asked for (it knows what it's showing). */
  private overlayReported: OverlayMode = 'hidden'
  private peekCheck: NodeJS.Timeout | null = null
  /** Horizontal offset applied to the active view while a swipe gesture is in progress. */
  private swipeOffset = 0
  private swipeAnimation: NodeJS.Timeout | null = null
  /** The tab whose swipe is in progress. */
  private swipeTabId: string | null = null
  /** After a swipe navigates, its momentum tail is ignored until the trackpad goes quiet. */
  private swipeCooldown: { tabId: string; until: number } | null = null
  private layoutAnimation: NodeJS.Timeout | null = null
  private pip!: PipPlayer
  private autofill!: AutofillController
  private readonly disposers: (() => void)[] = []
  /** Tabs we already offered to pause other media for, so the tip never nags. */
  private readonly mediaTipShown = new Set<string>()
  /** Folders in spaces' pinned areas (the tree itself is space.pinnedItems and folder.items). */
  private folders: Folder[] = []
  /** Capture mode's frozen frame of the page (see startCapture). */
  private captureFrame: { tabId: string; image: Electron.NativeImage; page: Rect; zoom: number; scroll: [number, number] } | null = null
  /** The last capture, for Save, Show in Finder and dragging out. */
  private lastCapture: {
    png: Buffer
    temp: string
    saved: string | null
    name: string
    thumbnail: string
    size: [number, number]
  } | null = null
  /** Tabs showing a translation (each run has its own token, so a stopped one ends). */
  private readonly translating = new Map<string, symbol>()
  /** Typed addresses tried over HTTPS first (see did-fail-load). */
  private readonly httpsFirst = new Set<string>()
  /** Tabs with a "not responding" question open. */
  private readonly hungTabs = new Set<string>()
  /** Tabs whose video went into Chromium's own picture-in-picture (iframes). */
  private readonly nativePipTabs = new Set<string>()
  /** When each tab's media metadata was last read. */
  private readonly mediaReadAt = new Map<string, number>()
  /** Pages whose permission prompts are dropped when they go away. */
  private readonly promptWatched = new WeakSet<WebContents>()
  /** Pages showing the system print dialog (they're waiting on it, not hung). */
  private readonly printing = new Set<number>()
  /** Tabs closing once their page agrees (a "Leave site?" question may be open). */
  private readonly closingTabs = new Set<string>()
  private readonly askingToLeave = new Set<string>()
  /** Popup windows opened by this window's tabs, with the tab that opened each. */
  private readonly popups = new Map<BrowserWindow, string>()
  /** When each tab's page last had a click or key press (for pop-up blocking). */
  private readonly lastInput = new Map<number, number>()
  /** Error pages shown for failed loads, and the address each stands in for. */
  private readonly errorPages = new Map<string, string>()
  private tidying = false
  private tidySeq = 0
  /** The last Tidy, so Undo can put things back. */
  private lastTidy: { token: number; spaceId: string; folders: string[]; tabs: string[]; before: string[] } | null = null
  /** Page dialogs (alert/confirm/prompt) and sign-in requests waiting for an answer, oldest first. */
  private pendingDialogs: { id: number; tabId: string | undefined; popover: PopoverSpec; answer: (ok: boolean, value: string) => void }[] =
    []
  private showingDialog: number | null = null
  private dialogSeq = 0
  /** Per tab, per page: how many dialogs it has shown, and whether you've blocked more. */
  private readonly dialogGuard = new Map<string, { count: number; suppressed: boolean }>()
  /** Tabs that wanted Widevine while it was off; reloaded once it's ready. */
  private readonly widevineTabs = new Set<string>()
  /** Sites already asked about Widevine this session. */
  private readonly widevineAsked = new Set<string>()
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
    private readonly ses: Session,
    private readonly seed?: WindowSeed
  ) {
    this.stateFile = kind === 'main' ? new JsonFile<PersistedState>('zepper-state.json', 800) : null
    this.permissions = kind === 'private' ? new SitePermissions(false) : hub.services.permissions
    const saved = this.stateFile?.read()
    if (saved?.version === 1 && saved.spaces.length > 0) {
      // Spaces from before profiles keep sharing the existing sign-ins (as they did); you can
      // separate any of them from its context menu (Sign-ins).
      this.spaces = saved.spaces.map((space) => ({ ...space, profile: space.profile ?? DEFAULT_PROFILE }))
      // Settings › Tabs decides whether last session's open tabs and Essentials come back.
      const { restoreTabs, keepEssentials } = hub.services.settings.get()
      this.tabs = saved.tabs
        .filter((t) => (t.kind !== 'normal' || restoreTabs) && (t.kind !== 'essential' || keepEssentials))
        .map((t) => makeTab({ ...t, language: null, translation: null }))
      // Essentials used to be shared by every space; now each space has its own, starting with a copy.
      const shared = this.tabs.filter((t) => t.kind === 'essential' && !t.spaceId)
      if (shared.length > 0) {
        this.tabs = this.tabs.filter((t) => !shared.includes(t))
        this.spaces.forEach((space, i) => {
          for (const tab of shared) {
            this.tabs.push(
              i === 0
                ? { ...tab, spaceId: space.id }
                : makeTab({ ...tab, id: randomUUID(), spaceId: space.id, loaded: false, loading: false, audible: false, media: null })
            )
          }
        })
      }
      this.activeSpaceId = saved.spaces.some((s) => s.id === saved.activeSpaceId) ? saved.activeSpaceId : saved.spaces[0].id
      this.restoreTabId = saved.activeTabId
      const ids = new Set(this.tabs.map((t) => t.id))
      this.splits = (saved.splits ?? [])
        .map((split) => ({ ...split, tabIds: split.tabIds.filter((id) => ids.has(id)) }))
        .filter((split) => split.tabIds.length >= 2)
      this.sidebarWidth = Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, saved.sidebarWidth ?? DEFAULT_SIDEBAR))
      this.folders = (saved.folders ?? []).filter((f) => this.space(f.spaceId))
      this.savedWindow = saved.window
      this.compact = saved.compact ?? false
      // Pinned areas from before folders: the pinned tabs in their saved order.
      for (const space of this.spaces)
        space.pinnedItems ??= this.tabs.filter((t) => t.kind === 'pinned' && t.spaceId === space.id).map((t) => t.id)
      this.normalizePinned()
    } else if (kind === 'private') {
      const space = makeSpace(
        'Private',
        '🕶️',
        { colors: ['#3b2a6b', '#1b1934'], opacity: 0.7, texture: 0.15, scheme: 'dark' },
        DEFAULT_PROFILE
      )
      this.spaces = [space]
      this.tabs = []
      this.activeSpaceId = space.id
      this.sidebarWidth = DEFAULT_SIDEBAR
      this.compact = false
    } else if (kind === 'blank' && seed?.space) {
      this.spaces = [seed.space]
      this.tabs = []
      this.activeSpaceId = seed.space.id
      this.sidebarWidth = seed.sidebarWidth
      this.compact = seed.compact
    } else if (kind === 'blank') {
      const space = makeSpace('New Window', '🪟', DEFAULT_THEME, DEFAULT_PROFILE)
      this.spaces = [space]
      this.tabs = []
      this.activeSpaceId = space.id
      this.sidebarWidth = DEFAULT_SIDEBAR
      this.compact = false
    } else {
      const space = makeSpace('Personal', '😀', DEFAULT_THEME, DEFAULT_PROFILE)
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

  start(initialUrl?: string): void {
    const { rendererUrl, rendererDir } = this.hub.services
    readNaturalScrolling()
    const preload = join(__dirname, '../preload/index.js')
    const uiPrefs = { preload, contextIsolation: true, sandbox: true, partition: 'zepper-ui' }

    this.win = new BrowserWindow({
      ...this.initialBounds(),
      minWidth: 640,
      minHeight: 495,
      show: false,
      titleBarStyle: 'hidden',
      // Let the first click on an inactive window hit the button under it.
      acceptFirstMouse: true,
      trafficLightPosition: TRAFFIC_LIGHTS,
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
    this.win.on('resize', () => {
      this.layout()
      this.broadcast()
    })
    // Remember where the window is, like other Mac apps (saved with the rest of the state).
    this.win.on('moved', () => this.broadcast())
    this.win.on('close', () => {
      this.savedWindow = { bounds: this.win.getNormalBounds(), maximized: this.win.isMaximized() }
    })
    if (this.savedWindow?.maximized) this.win.maximize()
    this.win.on('focus', () => this.broadcast())
    // macOS puts the traffic lights back at their default spot after full screen.
    this.win.on('leave-full-screen', () => this.showTrafficLights(!this.compact || this.peeking))
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
      onClosed: () => this.broadcast()
    })

    this.autofill = new AutofillController(
      {
        win: this.win,
        uiPreferences: uiPrefs,
        load,
        settings: () => this.settings,
        updateSettings: (patch) => this.settingsStore.update(patch),
        pageBounds: (wc) => {
          const id = this.tabByWebContents.get(wc.id)
          const view = id && this.attached.has(id) ? this.views.get(id) : undefined
          return view ? view.getBounds() : null
        },
        ownsVisiblePage: (wc) => {
          const id = this.tabByWebContents.get(wc.id)
          return Boolean(id && this.attached.has(id) && this.win.isVisible() && this.overlayMode !== 'full')
        },
        openPasswordSettings: () => this.handle({ type: 'ui.openSettings', section: 'passwords' })
      },
      this.hub.services.vault
    )

    this.overlay.webContents.once('did-finish-load', () => {
      const restore = this.restoreTabId && this.tab(this.restoreTabId)
      if (initialUrl) this.openTab(initialUrl)
      else if (restore) this.activateTab(restore.id)
      // First launch: the welcome and setup, once the window has settled.
      if (this.kind === 'main' && !this.settings.onboarded) setTimeout(() => this.handle({ type: 'ui.openOnboarding' }), 600)
      // Reloaded later (or after a crash), the overlay starts empty: nothing of it may stay over the window.
      this.overlay.webContents.on('did-finish-load', () => this.resetOverlay())
    })
    this.overlay.webContents.on('render-process-gone', () => this.resetOverlay())

    this.applySettings(this.settings, null)
    this.disposers.push(this.settingsStore.onChange((next, prev) => this.applySettings(next, prev)))
    this.showTrafficLights(!this.compact)
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
        const autofill = this.autofill.visible()
        if (autofill) layers.push({ name: 'autofill', webContents: autofill.webContents, bounds: autofill.bounds })
        return layers
      },
      handle: (command) => this.handle(command),
      snapshotJson: () => this.snapshot(),
      evaluate: async (code) => this.activeWebContents()?.executeJavaScript(code, true) ?? null,
      move: (layer, x, y) => {
        const wc = layer === 'chrome' ? this.win.webContents : layer === 'tab' ? this.activeWebContents() : this.overlay.webContents
        wc?.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
      },
      state: () => ({
        activeTabId: this.activeTabId,
        overlayMode: this.overlayMode,
        showingDialog: this.showingDialog,
        showingPrompt: this.showingPrompt,
        pendingDialogs: this.pendingDialogs.map((d) => ({ id: d.id, tabId: d.tabId, kind: d.popover.kind })),
        lastInput: Object.fromEntries([...this.lastInput].map(([id, at]) => [id, Date.now() - at])),
        popups: this.popups.size,
        history: (() => {
          const history = this.activeWebContents()?.navigationHistory
          return history && { active: history.getActiveIndex(), entries: history.getAllEntries().map((e) => e.url.slice(0, 50)) }
        })(),
        windows: BrowserWindow.getAllWindows().map((w) => ({
          title: w.getTitle(),
          url: w.webContents.getURL().slice(0, 80),
          visible: w.isVisible()
        })),
        browsers: [...this.hub.browsers].map((b) => b.debugSummary())
      }),
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
    // A prompt for a popup would show in the window behind it; popups don't get permissions.
    if (this.popupWindow(wc.id)) return callback(false)
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes as string[] | undefined) : undefined
    const externalURL = 'externalURL' in details ? details.externalURL : undefined
    const keys = settingKeys(permission, mediaTypes, externalURL)
    if (!keys) return callback(false)
    const origin = originOf(details.requestingUrl ?? wc.getURL())
    const states = keys.map((k) => this.permissions.get(origin, k))
    if (states.includes('block')) return callback(false)
    if (states.every((s) => s === 'allow')) return this.grant(keys, callback)
    this.prompts.push({
      id: ++this.promptSeq,
      origin,
      host: safeHost(origin) || origin,
      label: promptLabel(permission, keys, externalURL),
      keys,
      tabId: this.tabByWebContents.get(wc.id),
      webContentsId: wc.id,
      callback
    })
    // Once per page (not per round of prompts, which would pile listeners up on sites that keep asking).
    if (!this.promptWatched.has(wc)) {
      this.promptWatched.add(wc)
      const id = wc.id
      wc.once('destroyed', () => this.dropPrompts((p) => p.webContentsId === id))
    }
    this.showNextPrompt()
  }

  /**
   * Allows a request. The camera and microphone also need macOS's permission: it's asked for here,
   * so its prompt comes straight after ours, and if it was refused before you're told where to turn it on.
   */
  private grant(keys: string[], callback: (granted: boolean) => void): void {
    const media = (['camera', 'microphone'] as const).filter((kind) => keys.includes(kind))
    if (process.platform !== 'darwin' || media.length === 0) return callback(true)
    void (async () => {
      for (const kind of media) {
        const status = systemPreferences.getMediaAccessStatus(kind)
        if (status === 'not-determined') await systemPreferences.askForMediaAccess(kind).catch(() => false)
        else if (status === 'denied' || status === 'restricted') {
          this.toast({
            id: `system-${kind}`,
            message: `macOS is blocking Zepper’s ${kind}`,
            description: 'Turn on Zepper in Privacy & Security, then reload the page.',
            action: { label: 'Open Settings', command: { type: 'app.openMediaPrivacySettings', kind } },
            timeout: 8000
          })
        }
      }
      callback(true)
    })()
  }

  /** Permissions the site was refused, for the page's own view of its permissions. */
  blockedPermissions(origin: string): string[] {
    return this.permissions.blocked(origin)
  }

  checkPermission(permission: string, requestingOrigin: string, details: PermissionCheckHandlerHandlerDetails): boolean {
    if (this.permissions.isAlwaysAllowed(permission)) return true
    const mediaType = 'mediaType' in details ? (details.mediaType as string | undefined) : undefined
    const keys = settingKeys(permission, mediaType && mediaType !== 'unknown' ? [mediaType] : undefined)
    if (!keys) return true
    return keys.every((k) => this.permissions.get(originOf(requestingOrigin), k) === 'allow')
  }

  handleDownload(item: DownloadItem): void {
    const { downloadAsk, downloadPath } = this.settings
    const folder = downloadPath && existsSync(downloadPath) ? downloadPath : app.getPath('downloads')
    const path = uniquePath(join(folder, item.getFilename()))
    // Without a save path, Electron asks where to save it.
    if (downloadAsk) item.setSaveDialogOptions({ defaultPath: path })
    else item.setSavePath(path)
    const name = basename(path)
    // The downloads button shows progress; the list lives in the downloads panel.
    this.hub.downloads.track(item, path, this.kind === 'private')
    item.on('updated', () => {
      const total = item.getTotalBytes()
      if (total > 0 && !this.win.isDestroyed()) this.win.setProgressBar(item.getReceivedBytes() / total)
    })
    item.once('done', (_e, state) => {
      if (!this.win.isDestroyed()) this.win.setProgressBar(-1)
      // Where it actually went (you may have picked another place).
      const saved = item.getSavePath() || path
      const savedName = basename(saved)
      if (state === 'completed') {
        app.dock?.downloadFinished(saved)
        this.toast({
          id: `download-${name}`,
          message: 'Download complete',
          description: savedName,
          action: { label: 'Show', command: { type: 'download.show', path: saved } },
          timeout: 5000
        })
      } else if (state === 'interrupted') {
        this.toast({ id: `download-${name}`, message: 'Download failed', description: savedName, timeout: 4000 })
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
      id === this.autofill?.webContents()?.id ||
      this.tabByWebContents.has(id) ||
      this.popupWindow(id) !== undefined
    )
  }

  /** A popup window (OAuth, payments) belongs to the window whose tab opened it, and closes with it. */
  private adoptPopup(win: BrowserWindow, openerId: string): void {
    const wc = win.webContents
    if (this.tabByWebContents.has(wc.id)) return
    this.popups.set(win, openerId)
    win.once('closed', () => this.popups.delete(win))
    // Popups have no address bar, so the title says which site you're on (sign-in, payment…).
    const retitle = (): void => {
      if (!win.isDestroyed()) win.setTitle(`${safeHost(wc.getURL()) || 'Pop-up'} — ${wc.getTitle()}`)
    }
    wc.on('page-title-updated', (event) => {
      event.preventDefault()
      retitle()
    })
    wc.on('did-navigate', retitle)
    const wcId = wc.id
    wc.on('input-event', (_event, input) => {
      if (USER_INPUT.has(input.type)) this.lastInput.set(wcId, Date.now())
    })
    wc.once('destroyed', () => this.lastInput.delete(wcId))
    wc.on('did-create-window', (child) => this.adoptPopup(child, openerId))
    wc.setWindowOpenHandler((details) => {
      if (Date.now() - (this.lastInput.get(wcId) ?? 0) > USER_ACTIVATION_MS) return { action: 'deny' }
      if (details.disposition === 'new-window' && details.features) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 700,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegrationInSubFrames: true, safeDialogs: true, plugins: true }
          }
        }
      }
      // Links a popup opens in a new tab go to a tab in this window.
      this.openTab(details.url, { background: details.disposition === 'background-tab' })
      return { action: 'deny' }
    })
  }

  private popupWindow(webContentsId: number): BrowserWindow | undefined {
    for (const win of this.popups.keys()) if (!win.isDestroyed() && win.webContents.id === webContentsId) return win
    return undefined
  }

  publicSnapshot(): Snapshot {
    return this.snapshot()
  }

  suggestions(text: string): Promise<Suggestion[]> {
    // Private windows don't draw on (or show) browsing history.
    return suggest(text, this.tabs, this.history, this.settings.searchSuggestions, this.kind === 'private', this.settings.paletteRecents)
  }

  /** Commands from this window's own UI (chrome, overlay, player controls) only, never from web pages. */
  handleFromUi(sender: WebContents, command: Command): void {
    if (this.isUi(sender)) this.handle(command)
  }

  /** The window's own UI (sidebar, overlay, picture-in-picture controls), as opposed to web pages. */
  isUi(wc: WebContents): boolean {
    return [
      this.win.webContents.id,
      this.overlay.webContents.id,
      this.pip.controlsWebContents()?.id,
      this.autofill.webContents()?.id
    ].includes(wc.id)
  }

  /** A page's passkey request (navigator.credentials), answered by Zepper's password manager. */
  async onWebAuthn(wc: WebContents, frame: Electron.WebFrameMain | null, kind: 'create' | 'get', options: string): Promise<string> {
    if (!frame || !this.tabByWebContents.has(wc.id) || this.win.isDestroyed()) {
      return JSON.stringify({ ok: false, name: 'NotAllowedError', message: 'The document is not focused.' })
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(options) as Record<string, unknown>
    } catch {
      return JSON.stringify({ ok: false, name: 'TypeError', message: 'Bad request.' })
    }
    return this.autofill.requestPasskey(wc, frame, kind, parsed)
  }

  /** The page aborted its passkey request. */
  cancelWebAuthn(wc: WebContents): void {
    this.autofill.cancelPasskey(wc)
  }

  /** Sign-in fields in this window's pages report here (see AutofillController). */
  onPasswordsMessage(wc: WebContents, frame: Electron.WebFrameMain | null, message: PageMessage): void {
    if (this.tabByWebContents.has(wc.id)) this.autofill.onPageMessage(wc, frame, message)
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
    this.autofill?.destroy()
    for (const dispose of this.disposers) dispose()
    for (const view of this.views.values()) {
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }
    this.views.clear()
    this.tabByWebContents.clear()
    for (const popup of this.popups.keys()) if (!popup.isDestroyed()) popup.destroy()
    this.popups.clear()
    // Child views' pages outlive their window unless closed.
    if (!this.overlay.webContents.isDestroyed()) this.overlay.webContents.close()
    this.hub.windowClosed(this)
  }

  /**
   * Where a new window opens: the main window where you left it (if that's still on a
   * screen), otherwise a comfortable default; other windows cascade from the default.
   */
  private initialBounds(): Partial<Rectangle> {
    const saved =
      this.kind === 'main'
        ? this.savedWindow?.bounds
        : this.seed && { ...this.seed.bounds, x: this.seed.bounds.x + 24, y: this.seed.bounds.y + 24 }
    if (saved && saved.width >= 640 && saved.height >= 495) {
      const area = screen.getDisplayMatching(saved).workArea
      const visibleX = Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x)
      const visibleY = Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y)
      if (visibleX >= 200 && visibleY >= 120) return saved
    }
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const width = Math.min(this.kind === 'main' ? 1440 : 1280, area.width - 40)
    const height = Math.min(this.kind === 'main' ? 900 : 820, area.height - 40)
    return { width, height }
  }

  /** Development: what this window holds, for /state. */
  debugSummary(): unknown {
    const space = this.space(this.activeSpaceId)
    const count = (kind: TabKind): number => this.tabs.filter((t) => t.kind === kind).length
    return {
      kind: this.kind,
      bounds: this.win.isDestroyed() ? null : this.win.getBounds(),
      space: space && `${space.icon} ${space.name} (${space.profile.slice(0, 8)})`,
      essentials: count('essential'),
      pinned: count('pinned'),
      normal: count('normal'),
      folders: this.folders.map((f) => f.name)
    }
  }

  /** What a new window opened from this one starts with (see WindowSeed). */
  seedForNewWindow(includeSpace: boolean): WindowSeed {
    const bounds = this.win.getNormalBounds()
    const base = { bounds, sidebarWidth: this.sidebarWidth, compact: this.compact }
    const current = this.space(this.activeSpaceId)
    if (!includeSpace || !current) return base
    // The same space in a window of its own: its look and sign-ins, but none of its tabs.
    return { ...base, space: { ...current, id: randomUUID(), lastTabId: null, pinnedItems: [], collapsedPins: false } }
  }

  session(): Session {
    return this.ses
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
    // The passwords dropdown handles all of its own commands.
    if (command.type.startsWith('autofill.')) return this.autofill.handle(command)
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
        return this.reloadPage(this.activeWebContents())
      case 'space.switch':
        return this.switchSpace(command.spaceId)
      case 'space.switchRelative':
        return this.switchSpaceRelative(command.delta)
      case 'space.create':
        return void this.createSpace(command.name, command.icon, command.theme, command.profile ?? { mode: 'new' })
      case 'item.drop':
        return this.dropItem(command.item, command.target)
      case 'folder.create':
        return this.createFolder(command.spaceId, command.parentId, command.tabIds)
      case 'folder.update':
        return this.updateFolder(command.folderId, command.patch)
      case 'tabs.closeStale':
        return this.closeStale(command.spaceId, command.tabIds)
      case 'tabs.folderStale':
        return this.folderStale(command.spaceId, command.tabIds)
      case 'space.dismissStale': {
        const space = this.space(command.spaceId)
        if (space) space.staleDismissedAt = Date.now()
        return this.broadcast()
      }
      case 'space.tidy':
        return void this.tidySpace(command.spaceId)
      case 'space.untidy':
        return this.untidy(command.token)
      case 'folder.contextMenu':
        return this.folderContextMenu(command.folderId)
      case 'space.setProfile':
        return void this.setSpaceProfile(command.spaceId, command.profile)
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
      case 'ui.overlayCorner':
        this.cornerSize = {
          width: Math.max(1, Math.min(CORNER_REGION.width, Math.round(command.width))),
          height: Math.max(1, Math.min(2000, Math.round(command.height)))
        }
        return this.overlayMode === 'corner' ? this.layoutOverlay() : undefined
      case 'ui.overlayMode':
        this.overlayReported = command.mode
        // The overlay isn't showing the peek card (it may never have heard about it): stop peeking,
        // or an invisible overlay would keep covering the sidebar's edge.
        if (this.peeking && command.mode !== 'peek' && command.mode !== 'full') this.endPeek()
        return this.setOverlayMode(command.mode)
      case 'ui.openPopover':
        this.setOverlayMode('full')
        this.overlay.webContents.focus()
        return this.emit({ type: 'popover.open', popover: command.popover }, 'overlay')
      case 'ui.copyUrl':
        return this.copyUrl(command.markdown ?? false)
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
        return void this.toggleMedia(command.tabId)
      case 'dialog.respond':
        return this.respondToDialog(command.id, command.ok, command.value, command.suppress)
      case 'auth.respond':
        return this.respondToDialog(
          command.id,
          command.username !== null,
          JSON.stringify({ username: command.username ?? '', password: command.password })
        )
      case 'widevine.respond':
        return this.respondToWidevine(command.choice)
      case 'app.relaunch':
        return this.hub.relaunch()
      case 'app.makeDefaultBrowser':
        return this.hub.makeDefaultBrowser()
      case 'capture.take':
      case 'capture.cancel':
      case 'capture.save':
      case 'capture.reveal':
      case 'capture.retake':
      case 'capture.drag':
      case 'capture.dismiss':
        return this.captureCommand(command)
      case 'page.translate':
        return void this.translatePage(command.tabId)
      case 'app.openTranslationSettings':
        return void shell.openExternal('x-apple.systempreferences:com.apple.Localization-Settings.extension')
      case 'app.openMediaPrivacySettings':
        return void shell.openExternal(
          `x-apple.systempreferences:com.apple.preference.security?Privacy_${command.kind === 'camera' ? 'Camera' : 'Microphone'}`
        )
      case 'ui.openAssistant':
        return this.openAssistant(command.anchor)
      case 'assistant.run':
        return void this.runAssistant(command.requestId, command.question, command.history ?? [])
      case 'site.setProtection':
        return this.setSiteProtection(command.domain, command.key, command.enabled)
      case 'site.resetProtections': {
        const exceptions = { ...this.settings.siteExceptions }
        delete exceptions[command.domain]
        this.settingsStore.update({
          siteExceptions: exceptions,
          adblockAllowlist: this.settings.adblockAllowlist.filter((d) => d !== command.domain)
        })
        return this.reloadSite(command.domain)
      }
      case 'data.clear': {
        const { type: _type, ...what } = command
        return void this.hub.clearBrowsingData(what).then(() => {
          const cleared = [
            what.history && 'history',
            what.cookies && 'cookies and site data',
            what.cache && 'cached files',
            what.downloads && 'downloads list'
          ]
            .filter(Boolean)
            .join(', ')
          this.toast({ id: 'data-cleared', message: 'Browsing data cleared', description: cleared, timeout: 3500 })
        })
      }
      case 'window.open':
        return void this.hub.openWindow(command.kind)
      case 'site.setAdblock':
        return this.setSiteAdblock(command.domain, command.enabled)
      case 'media.seek': {
        const wc = this.views.get(command.tabId)?.webContents
        const seconds = Math.max(-600, Math.min(600, Number(command.seconds) || 0))
        if (wc && seconds) void this.runInFrames(wc, mediaSeekScript(seconds), true, true)
        return
      }
      case 'media.pauseOthers':
        return this.pauseOthers(command.keepTabId)
      case 'pip.back': {
        const id = this.pip.activeTabId
        if (id) this.pipBack(id)
        return
      }
      case 'pip.close':
        // The video goes back to its tab and keeps playing there.
        this.pip.exit()
        return this.broadcast()
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
      case 'page.zoom':
        return this.zoomActive(command.direction)
      case 'find.query':
        return this.find(command.text, command.forward, command.findNext)
      case 'find.stop':
        this.activeWebContents()?.stopFindInPage('clearSelection')
        return
      case 'settings.chooseDownloadFolder':
        return void this.chooseDownloadFolder()
      case 'download.action':
        return void this.hub.downloads[command.action](command.id)
      case 'downloads.clear':
        return this.hub.downloads.clear()
      case 'extension.setEnabled':
        return void this.extensions?.setEnabled(command.id, command.enabled)
      case 'extension.remove':
        return void this.removeExtension(command.id)
      case 'extension.options': {
        const url = this.extensions?.optionsUrl(command.id)
        if (url) this.openTab(url)
        return
      }
      case 'ui.openAbout':
        return void this.openAbout()
      case 'ui.openHistory':
        this.setOverlayMode('full')
        this.overlay.webContents.focus()
        return this.emit({ type: 'history.open' }, 'overlay')
      case 'history.remove':
        return this.history.remove(command.url)
      case 'history.clear':
        return this.history.clearSince(command.since)
      case 'ui.downloads':
        this.setOverlayMode('full')
        this.overlay.webContents.focus()
        return this.emit({ type: 'downloads.open' }, 'overlay')
      case 'download.show':
        return shell.showItemInFolder(command.path)
      case 'settings.update':
        return this.settingsStore.update(command.patch)
      case 'ui.openSettings':
        this.setOverlayMode('full')
        this.overlay.webContents.focus()
        return this.emit({ type: 'settings.open', section: command.section }, 'overlay')
      case 'ui.openOnboarding':
        this.setOverlayMode('full')
        this.overlay.webContents.focus()
        return this.emit({ type: 'onboarding.open' }, 'overlay')
      case 'ui.peekSidebar':
        return this.setPeek(command.show)
      case 'ui.peekLights':
        // Only for a left-hand peek: with the sidebar on the right, the lights would sit on the page.
        if (!this.compact || !this.peeking || this.settings.sidebarPosition === 'right') return
        return this.showTrafficLights(command.visible)
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
    if (prev && prev.blockFingerprinting !== next.blockFingerprinting) {
      for (const view of this.views.values()) {
        view.webContents.setWebRTCIPHandlingPolicy(next.blockFingerprinting ? 'default_public_interface_only' : 'default')
      }
    }
    // Setting these again makes macOS and the ad blocker redo work, so only when they changed.
    if (nativeTheme.themeSource !== next.colorScheme) nativeTheme.themeSource = next.colorScheme
    setSearchEngine(next.searchEngine)
    if (!prev || prev.adblock !== next.adblock) this.adblock.setEnabled(next.adblock)
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
    const inSpace = (kind: TabKind): Tab[] => this.tabs.filter((t) => t.kind === kind && t.spaceId === this.activeSpaceId)
    return [...inSpace('essential'), ...inSpace('pinned'), ...inSpace('normal')]
  }

  private activeWebContents(): WebContents | undefined {
    return this.activeTabId ? this.views.get(this.activeTabId)?.webContents : undefined
  }

  /** Opens a URL in a new normal tab at the top of a space's list (newest first). */
  openTab(url: string, options: { spaceId?: string; background?: boolean; afterTabId?: string } = {}): Tab {
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
    // Typed without a scheme and sent to HTTPS: fall back to HTTP if the site has no HTTPS.
    if (/^https:/.test(url) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim()) && !/\s/.test(input.trim())) {
      this.httpsFirst.add(normalizedUrl(url))
      if (this.httpsFirst.size > 50) this.httpsFirst.delete(this.httpsFirst.values().next().value!)
    }
    const current = this.tab(this.activeTabId)
    if (where === 'split') {
      const tab = makeTab({ kind: 'normal', url, spaceId: this.activeSpaceId })
      this.insertNormalTab(tab, current?.kind === 'normal' ? current.id : undefined)
      if (current) this.addToSplit(tab.id)
      else this.activateTab(tab.id)
      return
    }
    // Navigating a pinned tab or Essential away from its site opens a new tab instead.
    const leavesPin = where === 'current' && !!current?.pinned && safeHost(url) !== safeHost(current.pinned.url)
    if (where === 'new' || !current || leavesPin) {
      this.openTab(url)
      return
    }
    const view = this.ensureView(current)
    // A failed or aborted load shows in the page itself.
    view.webContents.loadURL(url).catch(() => {})
    this.activateTab(current.id)
  }

  activateTab(id: string, options: { keepRecency?: boolean } = {}): void {
    const tab = this.tab(id)
    if (!tab) return
    const previousId = this.activeTabId
    const sameSplit = !!previousId && this.splitOf(previousId) !== undefined && this.splitOf(previousId) === this.splitOf(id)
    if (tab.spaceId && tab.spaceId !== this.activeSpaceId) {
      this.activeSpaceId = tab.spaceId
    }
    if (this.pip.activeTabId === id) this.pip.exit()
    if (this.swipeOffset !== 0) {
      this.stopSwipeAnimation()
      this.swipeOffset = 0
    }
    this.activeTabId = id
    if (previousId !== id) this.autofill?.hide()
    const view = this.ensureView(tab)
    this.syncAttachedViews()
    // Only once the old tab is off screen can its video float.
    if (previousId && previousId !== id && !sameSplit) void this.autoPictureInPicture(previousId)

    if (!options.keepRecency) tab.lastActiveAt = Date.now()
    const space = this.space(this.activeSpaceId)
    if (space) space.lastTabId = id
    this.layout()
    if (!this.paletteOpen && this.overlayMode !== 'full') view.webContents.focus()
    this.extensions?.apiFor(view.webContents.session)?.selectTab(view.webContents)
    this.broadcast()
    this.showNextPrompt()
    this.showNextDialog()
    // Back on a tab whose video Chromium's picture-in-picture took: bring it back into the page.
    if (this.nativePipTabs.delete(id)) this.runInFrames(view.webContents, EXIT_AUTO_PIP_SCRIPT, false)
  }

  /** Arc-style auto picture-in-picture: a playing video floats when you leave its tab. */
  private async autoPictureInPicture(tabId: string): Promise<void> {
    if (!this.settings.autoPictureInPicture) return
    const tab = this.tab(tabId)
    const wc = this.views.get(tabId)?.webContents
    const view = this.views.get(tabId)
    if (!tab?.audible || tab.muted || !wc || !view) return
    if (this.attached.has(tabId)) return
    // Give quick tab flicks (⌃Tab cycling, a glance at another tab) a moment, so the player only
    // opens once you've really moved on.
    await new Promise((resolve) => setTimeout(resolve, PIP_DELAY_MS))
    if (this.windowClosed || this.attached.has(tabId) || this.activeTabId === tabId || !tab.audible || tab.muted) return
    if (this.views.get(tabId) !== view || this.pip.activeTabId === tabId) return
    // Our floating player handles videos in the page itself; iframe videos fall back to Chromium's.
    let entered = await this.pip.enter(tabId, view)
    if (entered && (this.activeTabId === tabId || this.attached.has(tabId))) {
      this.pip.exit()
      this.syncAttachedViews()
      return
    }
    if (!entered) {
      entered = await this.runInFrames(wc, AUTO_PIP_SCRIPT, true, 'pip')
      if (entered) this.nativePipTabs.add(tabId)
    }
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
    const names = others
      .map((t) => t.media?.title || t.title)
      .slice(0, 2)
      .join(', ')
    if (behavior === 'pause') {
      this.pauseOthers(tabId)
      this.toast({
        id: 'media-others',
        message: others.length === 1 ? 'Paused the other tab' : `Paused ${others.length} other tabs`,
        description: names,
        timeout: 3000
      })
      return
    }
    if (this.mediaTipShown.has(tabId)) return
    this.mediaTipShown.add(tabId)
    this.toast({
      id: 'media-others',
      message: others.length === 1 ? 'Another tab is still playing' : `${others.length} other tabs are playing`,
      description: names,
      action: { label: others.length === 1 ? 'Pause it' : 'Pause others', command: { type: 'media.pauseOthers', keepTabId: tabId } },
      timeout: 4000
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
  /** Play/pause from the media card or player: pauses what's playing in any frame (embedded players too), or resumes. */
  private async toggleMedia(tabId: string): Promise<void> {
    const wc = this.views.get(tabId)?.webContents
    if (!wc || wc.isDestroyed()) return
    let paused = false
    for (const frame of wc.mainFrame.framesInSubtree) {
      try {
        if ((await frame.executeJavaScript(MEDIA_PAUSE_PLAYING_SCRIPT, true)) === 'paused') paused = true
      } catch {
        // Cross-origin or detached frames can refuse.
      }
    }
    if (!paused) await this.runInFrames(wc, MEDIA_RESUME_SCRIPT, true, 'playing')
  }

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
    const previousId = this.activeTabId
    this.activeTabId = null
    this.syncAttachedViews()
    if (previousId) void this.autoPictureInPicture(previousId)
    const space = this.space(this.activeSpaceId)
    if (space) space.lastTabId = null
    this.broadcast()
  }

  /** Next tab after closing or unloading the active one: opener, then most recently used. */
  private pickNextTab(leaving: Tab): Tab | undefined {
    const candidates = this.visibleTabs().filter((t) => t.id !== leaving.id && (t.kind === 'normal' || t.loaded))
    const opener = this.tab(this.openers.get(leaving.id))
    if (opener && candidates.includes(opener)) return opener
    if (!this.settings.closeSelectsRecent) {
      const visible = this.visibleTabs()
      const index = visible.indexOf(leaving)
      const below = visible.slice(index + 1).find((t) => candidates.includes(t))
      const above = visible
        .slice(0, index)
        .reverse()
        .find((t) => candidates.includes(t))
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
    const wc = this.views.get(id)?.webContents
    if (!wc || wc.isDestroyed() || wc.isCrashed()) {
      this.closed.push({ ...tab, batch: ++this.closeBatch })
      return this.removeTab(tab)
    }
    // The page gets to run its beforeunload handler (and ask "Leave site?") before it closes.
    if (this.closingTabs.has(id)) return
    this.closingTabs.add(id)
    const finish = (): void => {
      clearTimeout(timer)
      if (!this.closingTabs.delete(id)) return
      const current = this.tab(id)
      if (!current) return
      this.closed.push({ ...current, batch: ++this.closeBatch })
      this.removeTab(current)
    }
    // 'close' is when the page agreed to close (Electron doesn't reliably run 'destroyed' listeners here).
    ;(wc as NodeJS.EventEmitter).once('close', finish)
    wc.once('destroyed', finish)
    // A page that doesn't answer (hung) closes anyway.
    const timer = setTimeout(() => {
      if (!this.closingTabs.has(id) || this.askingToLeave.has(id)) return
      finish()
    }, 1500)
    wc.close({ waitForBeforeUnload: true })
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
      void this.views
        .get(tab.id)
        ?.webContents.loadURL(tab.pinned.url)
        .catch(() => {})
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
    if (tab.kind === 'pinned' && !tab.loaded) {
      // Removes it, but ⇧⌘T brings it back.
      this.closed.push({ ...tab, batch: ++this.closeBatch })
      return this.removeTab(tab)
    }
    this.unloadPinned(tab, true)
  }

  private removeTab(tab: Tab): void {
    const wasActive = this.activeTabId === tab.id
    // Closing a pane keeps the rest of its split on screen.
    const splitSibling = this.splitOf(tab.id)?.tabIds.find((id) => id !== tab.id)
    this.leaveSplit(tab.id)
    const next = wasActive ? (this.tab(splitSibling) ?? this.pickNextTab(tab)) : undefined
    this.destroyView(tab)
    this.detachPinned(tab.id)
    this.tabs = this.tabs.filter((t) => t !== tab)
    this.openers.delete(tab.id)
    this.mediaReadAt.delete(tab.id)
    this.mediaTipShown.delete(tab.id)
    this.nativePipTabs.delete(tab.id)
    // Reopen Closed Tab remembers the last batches, not every tab ever closed.
    if (this.closed.length > MAX_CLOSED) this.closed.splice(0, this.closed.length - MAX_CLOSED)
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
    const space = this.space(tab.spaceId ?? '')
    if (space) {
      space.pinnedItems.push(tab.id)
      space.collapsedPins = false
    }
    this.syncPinnedOrder()
    this.broadcast()
  }

  private unpin(id: string): void {
    const tab = this.tab(id)
    if (!tab || tab.kind !== 'pinned') return
    tab.kind = 'normal'
    tab.pinned = null
    this.detachPinned(tab.id)
    this.moveToFront(tab)
    this.broadcast()
  }

  /** A space's Essentials, in order. */
  private essentialsOf(spaceId: string | null): Tab[] {
    return this.tabs.filter((t) => t.kind === 'essential' && t.spaceId === spaceId)
  }

  private addEssential(id: string): void {
    const tab = this.tab(id)
    if (!tab || tab.kind === 'essential') return
    const spaceId = tab.spaceId ?? this.activeSpaceId
    if (this.essentialsOf(spaceId).length >= MAX_ESSENTIALS) {
      this.toast({ id: 'essentials-full', message: 'Essentials are full', description: `A space can keep up to ${MAX_ESSENTIALS}.` })
      return
    }
    this.detachPinned(tab.id)
    tab.kind = 'essential'
    tab.spaceId = spaceId
    tab.pinned ??= { url: tab.url, title: tab.title, favicon: tab.favicon }
    this.moveToEnd(tab)
    this.rehome(tab)
    this.broadcast()
  }

  private removeEssential(id: string): void {
    const tab = this.tab(id)
    if (!tab || tab.kind !== 'essential') return
    tab.kind = 'normal'
    tab.spaceId ??= this.activeSpaceId
    tab.pinned = null
    this.moveToFront(tab)
    this.rehome(tab)
    this.broadcast()
  }

  private moveTabToSpace(id: string, spaceId: string): void {
    const tab = this.tab(id)
    if (!tab || !this.canMoveTo(tab, spaceId)) return
    this.setTabSpace(tab, spaceId)
    this.rehome(tab)
    this.activateTab(tab.id)
  }

  // ---------------------------------------------------------------------------
  // Pinned area tree (folders) and drag and drop
  //
  // A space's pinned area is a tree: space.pinnedItems and each folder's items hold tab and
  // folder ids in order. this.tabs keeps pinned tabs in the same (flattened) order, so code
  // that walks tabs in sidebar order works unchanged.

  private folder(id: string | null | undefined): Folder | undefined {
    return id ? this.folders.find((f) => f.id === id) : undefined
  }

  /** The list holding an item in a pinned tree, and where. */
  private containerOf(id: string): { list: string[]; index: number } | undefined {
    for (const list of [...this.spaces.map((s) => s.pinnedItems), ...this.folders.map((f) => f.items)]) {
      const index = list.indexOf(id)
      if (index >= 0) return { list, index }
    }
    return undefined
  }

  private detachPinned(id: string): void {
    const at = this.containerOf(id)
    if (at) at.list.splice(at.index, 1)
  }

  /** Folder ids inside a folder, at any depth. */
  private subfolders(folderId: string): string[] {
    const folder = this.folder(folderId)
    if (!folder) return []
    return folder.items.filter((id) => this.folder(id)).flatMap((id) => [id, ...this.subfolders(id)])
  }

  /** Pinned tab ids under a list, in order (folders expanded). */
  private flattenPinned(items: string[]): string[] {
    return items.flatMap((id) => (this.folder(id) ? this.flattenPinned(this.folder(id)!.items) : [id]))
  }

  /** Keeps this.tabs' pinned tabs in tree order. */
  private syncPinnedOrder(): void {
    const order = new Map(this.spaces.flatMap((s) => this.flattenPinned(s.pinnedItems)).map((id, i) => [id, i]))
    const pinned = this.tabs.filter((t) => t.kind === 'pinned').sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9))
    let next = 0
    this.tabs = this.tabs.map((t) => (t.kind === 'pinned' ? pinned[next++] : t))
  }

  /** Repairs the trees: every pinned tab listed once in its own space, nothing else listed. */
  private normalizePinned(): void {
    const seen = new Set<string>()
    const clean = (items: string[], spaceId: string): string[] =>
      items.filter((id) => {
        if (seen.has(id)) return false
        const tab = this.tab(id)
        const folder = this.folder(id)
        const ok = (tab?.kind === 'pinned' && tab.spaceId === spaceId) || folder?.spaceId === spaceId
        if (ok) seen.add(id)
        return ok
      })
    for (const space of this.spaces) space.pinnedItems = clean(space.pinnedItems ?? [], space.id)
    for (const folder of this.folders) folder.items = clean(folder.items, folder.spaceId)
    // Folders nobody contains go back to their space's top level.
    for (const folder of this.folders) {
      if (!seen.has(folder.id)) {
        this.space(folder.spaceId)?.pinnedItems.push(folder.id)
        seen.add(folder.id)
      }
    }
    for (const tab of this.tabs) {
      if (tab.kind === 'pinned' && !seen.has(tab.id)) this.space(tab.spaceId ?? '')?.pinnedItems.push(tab.id)
    }
    this.syncPinnedOrder()
  }

  /** Moves a tab to another space, keeping it pinned (at the end of that space's pinned area) or normal. */
  /** An Essential can move to another space only if that space's Essentials have room. */
  private canMoveTo(tab: Tab, spaceId: string): boolean {
    if (tab.kind !== 'essential' || this.essentialsOf(spaceId).length < MAX_ESSENTIALS) return true
    this.toast({ id: 'essentials-full', message: 'Essentials are full there', description: `A space can keep up to ${MAX_ESSENTIALS}.` })
    return false
  }

  private setTabSpace(tab: Tab, spaceId: string): void {
    if (tab.spaceId === spaceId) return
    tab.spaceId = spaceId
    if (tab.kind === 'pinned') {
      this.detachPinned(tab.id)
      this.space(spaceId)?.pinnedItems.push(tab.id)
      this.syncPinnedOrder()
    } else {
      this.moveToFront(tab)
    }
  }

  /** A tab or folder dropped somewhere in the sidebar (drag and drop). */
  private dropItem(item: { kind: 'tab' | 'folder'; id: string }, target: DropTarget): void {
    if (item.kind === 'folder') this.dropFolder(item.id, target)
    else this.dropTab(item.id, target)
    this.syncPinnedOrder()
    this.broadcast()
  }

  private dropTab(id: string, target: DropTarget): void {
    const tab = this.tab(id)
    if (!tab) return
    if (target.zone === 'space') {
      if (tab.spaceId === target.spaceId || !this.canMoveTo(tab, target.spaceId)) return
      // The tab you're on leaves this space, so another of its tabs takes its place.
      if (this.activeTabId === tab.id) {
        const next = this.pickNextTab(tab)
        if (next && next.spaceId === tab.spaceId) this.activateTab(next.id)
        else this.clearActiveTab()
      }
      this.setTabSpace(tab, target.spaceId)
      this.rehome(tab)
      const space = this.space(target.spaceId)
      if (space)
        this.toast({
          id: 'moved-to-space',
          message: `Moved to ${space.name}`,
          description: tab.title,
          action: { label: 'Switch', command: { type: 'space.switch', spaceId: space.id } }
        })
      return
    }
    if (target.zone === 'essentials') {
      const essentials = this.essentialsOf(target.spaceId)
      if (!essentials.includes(tab) && essentials.length >= MAX_ESSENTIALS) {
        this.toast({ id: 'essentials-full', message: 'Essentials are full', description: `A space can keep up to ${MAX_ESSENTIALS}.` })
        return
      }
      this.detachPinned(id)
      tab.kind = 'essential'
      tab.spaceId = target.spaceId
      tab.pinned ??= { url: tab.url, title: tab.title, favicon: tab.favicon }
      this.placeInList(tab, essentials, target.index)
      this.rehome(tab)
      return
    }
    if (target.zone === 'pinned') {
      if (!this.space(target.spaceId) || (target.parentId && this.folder(target.parentId)?.spaceId !== target.spaceId)) return
      const list = target.parentId ? this.folder(target.parentId)!.items : this.space(target.spaceId)!.pinnedItems
      const was = this.containerOf(id)
      let index = target.index
      if (was && was.list === list && was.index < index) index--
      this.detachPinned(id)
      tab.kind = 'pinned'
      tab.pinned ??= { url: tab.url, title: tab.title, favicon: tab.favicon }
      tab.spaceId = target.spaceId
      list.splice(Math.max(0, Math.min(index, list.length)), 0, id)
      this.rehome(tab)
      return
    }
    // A space's normal tabs, at a position.
    const normals = this.tabs.filter((t) => t.kind === 'normal' && t.spaceId === target.spaceId)
    this.detachPinned(id)
    tab.kind = 'normal'
    tab.pinned = null
    tab.spaceId = target.spaceId
    this.placeInList(tab, normals, target.index)
    this.rehome(tab)
  }

  /** Puts a tab at a position among a group of tabs (Essentials, or a space's normal tabs) in this.tabs. */
  private placeInList(tab: Tab, group: Tab[], index: number): void {
    const others = group.filter((t) => t !== tab)
    const wasAt = group.indexOf(tab)
    const at = Math.max(0, Math.min(wasAt >= 0 && wasAt < index ? index - 1 : index, others.length))
    const rest = this.tabs.filter((t) => t !== tab)
    const before = others[at]
    if (before) rest.splice(rest.indexOf(before), 0, tab)
    else if (others.length > 0) rest.splice(rest.indexOf(others[others.length - 1]) + 1, 0, tab)
    else rest.push(tab)
    this.tabs = rest
  }

  private dropFolder(id: string, target: DropTarget): void {
    const folder = this.folder(id)
    if (!folder || target.zone === 'essentials' || target.zone === 'normal') return
    const spaceId = target.spaceId
    const parentId = target.zone === 'pinned' ? target.parentId : null
    // A folder can't go inside itself.
    if (parentId && (parentId === id || this.subfolders(id).includes(parentId))) return
    const space = this.space(spaceId)
    const parent = this.folder(parentId)
    if (!space || (parentId && parent?.spaceId !== spaceId)) return
    const list = parent ? parent.items : space.pinnedItems
    const was = this.containerOf(id)
    let index = target.zone === 'pinned' ? target.index : list.length
    if (was && was.list === list && was.index < index) index--
    this.detachPinned(id)
    list.splice(Math.max(0, Math.min(index, list.length)), 0, id)
    if (folder.spaceId !== spaceId) {
      // Everything inside moves to the new space (and its sign-ins) too.
      for (const fid of [id, ...this.subfolders(id)]) this.folder(fid)!.spaceId = spaceId
      for (const tabId of this.flattenPinned(folder.items)) {
        const tab = this.tab(tabId)
        if (!tab) continue
        tab.spaceId = spaceId
        this.rehome(tab)
      }
    }
  }

  /** The space's normal tabs among `ids` (they may have moved or closed since the suggestion). */
  private staleTabs(spaceId: string, ids: string[]): Tab[] {
    return ids.flatMap((id) => {
      const tab = this.tab(id)
      return tab && tab.kind === 'normal' && tab.spaceId === spaceId && tab.id !== this.activeTabId ? [tab] : []
    })
  }

  /** Closes tabs you haven't opened lately, as one batch: a single ⇧⌘T brings them all back. */
  private closeStale(spaceId: string, ids: string[]): void {
    const tabs = this.staleTabs(spaceId, ids)
    if (tabs.length === 0) return
    const batch = ++this.closeBatch
    for (const tab of tabs) {
      this.closed.push({ ...tab, batch })
      this.removeTab(tab)
    }
    this.toast({
      id: 'stale',
      message: `Closed ${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}`,
      action: { label: 'Undo', command: { type: 'tab.reopenClosed' } },
      timeout: 6000
    })
  }

  /** Sets tabs you haven't opened lately aside in a dated folder in the pinned area. */
  private folderStale(spaceId: string, ids: string[]): void {
    const space = this.space(spaceId)
    const tabs = this.staleTabs(spaceId, ids)
    if (!space || tabs.length === 0) return
    const name = `Set aside ${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date())}`
    const folder: Folder = { id: randomUUID(), spaceId, name, collapsed: true, items: [] }
    this.folders.push(folder)
    space.pinnedItems.push(folder.id)
    for (const tab of tabs) this.dropTab(tab.id, { zone: 'pinned', spaceId, parentId: folder.id, index: folder.items.length })
    this.syncPinnedOrder()
    this.broadcast()
    this.toast({ id: 'stale', message: `Moved ${tabs.length} tabs to “${name}”`, timeout: 4000 })
  }

  /** Tidy Tabs: related normal tabs go into named folders in the pinned area, with Undo. */
  private async tidySpace(spaceId: string): Promise<void> {
    const space = this.space(spaceId)
    const normals = this.tabs.filter((t) => t.kind === 'normal' && t.spaceId === spaceId)
    if (!space || normals.length < 3 || this.tidying) return
    this.tidying = true
    const ai = this.hub.tidy.kind === 'ai' && this.settings.aiFeatures
    this.toast({ id: 'tidy', message: ai ? 'Tidying with Apple Intelligence…' : 'Tidying by site…', timeout: 30_000 })
    try {
      const groups = await tidyGroups(
        normals.map((t) => ({ title: t.title, url: t.url })),
        this.settings.aiFeatures
      )
      if (this.win.isDestroyed() || !this.space(spaceId)) return
      // Tabs closed or moved meanwhile are left out.
      const usable = groups
        .map((g) => ({
          name: g.name,
          tabs: g.tabs.map((i) => normals[i]).filter((t) => this.tab(t.id)?.kind === 'normal' && t.spaceId === spaceId)
        }))
        .filter((g) => g.tabs.length >= 2)
      if (usable.length === 0) {
        this.toast({ id: 'tidy', message: 'Nothing to tidy', description: 'These tabs don’t have much in common.', timeout: 3000 })
        return
      }
      const before = this.tabs.filter((t) => t.kind === 'normal' && t.spaceId === spaceId).map((t) => t.id)
      const folders: string[] = []
      for (const group of usable) {
        const folder: Folder = { id: randomUUID(), spaceId, name: group.name, collapsed: false, items: [] }
        this.folders.push(folder)
        space.pinnedItems.push(folder.id)
        folders.push(folder.id)
        for (const tab of group.tabs) this.dropTab(tab.id, { zone: 'pinned', spaceId, parentId: folder.id, index: folder.items.length })
      }
      space.collapsedPins = false
      this.syncPinnedOrder()
      this.broadcast()
      const token = ++this.tidySeq
      this.lastTidy = { token, spaceId, folders, tabs: usable.flatMap((g) => g.tabs.map((t) => t.id)), before }
      const moved = this.lastTidy.tabs.length
      this.toast({
        id: 'tidy',
        message: `Tidied ${moved} tabs into ${usable.length} ${usable.length === 1 ? 'folder' : 'folders'}`,
        description: usable.map((g) => g.name).join(', '),
        action: { label: 'Undo', command: { type: 'space.untidy', token } },
        timeout: 8000
      })
    } finally {
      this.tidying = false
    }
  }

  /** Undoes the last Tidy: its tabs go back among the normal tabs, in their old order, and its folders go. */
  private untidy(token: number): void {
    const last = this.lastTidy
    if (!last || last.token !== token) return
    this.lastTidy = null
    for (const tabId of last.tabs) {
      const tab = this.tab(tabId)
      // Only tabs still inside a Tidy folder; anything moved since stays where you put it.
      const at = this.containerOf(tabId)
      if (!tab || tab.kind !== 'pinned' || !last.folders.some((f) => this.folder(f)?.items === at?.list)) continue
      this.detachPinned(tabId)
      tab.kind = 'normal'
      tab.pinned = null
      tab.spaceId = last.spaceId
    }
    // Folders left empty go; anything you added to one stays pinned in its place.
    for (const folderId of last.folders) {
      const folder = this.folder(folderId)
      if (folder) this.removeFolder(folderId, false)
    }
    const order = new Map(last.before.map((id, i) => [id, i]))
    const rank = (t: Tab): number => order.get(t.id) ?? last.before.length
    const sorted = this.tabs.filter((t) => t.kind === 'normal' && t.spaceId === last.spaceId).sort((a, b) => rank(a) - rank(b))
    let next = 0
    this.tabs = this.tabs.map((t) => (t.kind === 'normal' && t.spaceId === last.spaceId ? sorted[next++] : t))
    this.syncPinnedOrder()
    this.broadcast()
    this.toast({ id: 'tidy', message: 'Tidy undone', timeout: 2000 })
  }

  private createFolder(spaceId: string, parentId: string | null, tabIds: string[] = []): void {
    const space = this.space(spaceId)
    const parent = this.folder(parentId)
    if (!space || (parentId && parent?.spaceId !== spaceId)) return
    const folder: Folder = { id: randomUUID(), spaceId, name: 'New Folder', collapsed: false, items: [] }
    this.folders.push(folder)
    ;(parent ? parent.items : space.pinnedItems).push(folder.id)
    for (const tabId of tabIds) this.dropTab(tabId, { zone: 'pinned', spaceId, parentId: folder.id, index: folder.items.length })
    space.collapsedPins = false
    this.syncPinnedOrder()
    this.broadcast()
    this.emitToSidebars({ type: 'folder.startRename', folderId: folder.id })
  }

  private updateFolder(id: string, patch: { name?: string; collapsed?: boolean }): void {
    const folder = this.folder(id)
    if (!folder) return
    if (patch.name !== undefined) folder.name = patch.name.trim() || folder.name
    if (patch.collapsed !== undefined) folder.collapsed = patch.collapsed
    this.broadcast()
  }

  /** Removes a folder; its tabs and folders take its place, or close with it. */
  private removeFolder(id: string, closeTabs: boolean): void {
    const folder = this.folder(id)
    const at = this.containerOf(id)
    if (!folder || !at) return
    if (closeTabs) {
      for (const tabId of this.flattenPinned(folder.items)) {
        const tab = this.tab(tabId)
        if (tab) this.removeTab(tab)
      }
      const gone = new Set([id, ...this.subfolders(id)])
      this.folders = this.folders.filter((f) => !gone.has(f.id))
      this.detachPinned(id)
    } else {
      at.list.splice(at.index, 1, ...folder.items)
      this.folders = this.folders.filter((f) => f.id !== id)
    }
    this.syncPinnedOrder()
    this.broadcast()
  }

  private folderContextMenu(id: string): void {
    const folder = this.folder(id)
    if (!folder) return
    const count = this.flattenPinned(folder.items).length
    this.popup([
      { label: 'Rename Folder', click: () => this.emitToSidebars({ type: 'folder.startRename', folderId: id }) },
      { label: 'New Folder Inside', click: () => this.createFolder(folder.spaceId, id) },
      { label: folder.collapsed ? 'Expand' : 'Collapse', click: () => this.updateFolder(id, { collapsed: !folder.collapsed }) },
      { type: 'separator' },
      { label: 'Ungroup (Keep Tabs)', click: () => this.removeFolder(id, false) },
      {
        label: count > 0 ? `Delete Folder and ${count} ${count === 1 ? 'Tab' : 'Tabs'}` : 'Delete Folder',
        click: () => this.removeFolder(id, true)
      }
    ])
  }

  /** "Add to Folder ▸" for a tab's context menu. */
  private folderMenuItems(tab: Tab): MenuItemConstructorOptions[] {
    if (tab.kind === 'essential' || !tab.spaceId) return []
    const spaceId = tab.spaceId
    const label = (folder: Folder): string => {
      const path: string[] = [folder.name]
      let parent = this.folders.find((f) => f.items.includes(folder.id))
      while (parent) {
        path.unshift(parent.name)
        parent = this.folders.find((f) => f.items.includes(parent!.id))
      }
      return path.join(' › ')
    }
    const current = this.folders.find((f) => f.items.includes(tab.id))
    const targets = this.folders.filter((f) => f.spaceId === spaceId && f !== current)
    return [
      {
        label: 'Add to Folder',
        submenu: [
          { label: 'New Folder', click: () => this.createFolder(spaceId, null, [tab.id]) },
          ...(targets.length > 0 ? [{ type: 'separator' } as MenuItemConstructorOptions] : []),
          ...targets.map((f) => ({
            label: label(f),
            click: () => this.dropItem({ kind: 'tab', id: tab.id }, { zone: 'pinned', spaceId, parentId: f.id, index: f.items.length })
          }))
        ]
      },
      ...(current
        ? [
            {
              label: 'Remove from Folder',
              click: () =>
                this.dropItem(
                  { kind: 'tab', id: tab.id },
                  { zone: 'pinned', spaceId, parentId: null, index: this.space(spaceId)!.pinnedItems.length }
                )
            }
          ]
        : [])
    ]
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
    const tab = this.essentialsOf(this.activeSpaceId)[n - 1]
    if (tab) this.activateTab(tab.id)
  }

  /**
   * ⇧⌘2: capture mode. The page is frozen as it is (so hover effects or a playing video can't change
   * the shot), then the overlay lets you click an element or drag a region; Visible and Full page
   * take the whole screen or the whole page.
   */
  async startCapture(): Promise<void> {
    const tab = this.tab(this.activeTabId)
    const view = tab && this.views.get(tab.id)
    const wc = view?.webContents
    if (!tab || !view || !wc || wc.isDestroyed() || !/^(https?|file):/.test(wc.getURL())) return
    const page = view.getBounds()
    const zoom = wc.getZoomFactor()
    const [image, info] = await Promise.all([
      wc.capturePage(),
      wc
        .executeJavaScriptInIsolatedWorld(ZEPPER_WORLD, [{ code: CAPTURE_TARGETS_SCRIPT }])
        .catch(() => null) as Promise<CaptureTargets | null>
    ])
    this.captureFrame = { tabId: tab.id, image, page, zoom, scroll: info ? [info.scrollX, info.scrollY] : [0, 0] }
    const targets = (info?.targets ?? []).map(([x, y, width, height]) => ({
      x: page.x + x * zoom,
      y: page.y + y * zoom,
      width: width * zoom,
      height: height * zoom
    }))
    this.overlay.webContents.focus()
    this.emit({ type: 'capture.start', page, targets, scrolls: info?.scrolls ?? false }, 'overlay')
  }

  /** Takes the capture: from the frozen frame, or (full page, or areas reaching off screen) from the page itself. */
  private async takeCapture(mode: 'visible' | 'full' | 'area', rect?: Rect): Promise<void> {
    const frame = this.captureFrame
    this.captureFrame = null
    const wc = frame && this.views.get(frame.tabId)?.webContents
    if (!frame || !wc || wc.isDestroyed()) return
    const scale = frame.image.getSize().width / Math.max(1, frame.page.width)
    let png: Buffer
    try {
      if (mode === 'full') {
        png = await captureFullPage(wc)
      } else if (mode === 'area' && rect) {
        const x = rect.x - frame.page.x
        const y = rect.y - frame.page.y
        const inside = x >= 0 && y >= 0 && x + rect.width <= frame.page.width + 1 && y + rect.height <= frame.page.height + 1
        png = inside
          ? frame.image
              .crop({
                x: Math.round(x * scale),
                y: Math.round(y * scale),
                width: Math.max(1, Math.round(rect.width * scale)),
                height: Math.max(1, Math.round(rect.height * scale))
              })
              .toPNG()
          : await captureArea(wc, {
              x: frame.scroll[0] + x / frame.zoom,
              y: frame.scroll[1] + y / frame.zoom,
              width: rect.width / frame.zoom,
              height: rect.height / frame.zoom
            })
      } else {
        png = frame.image.toPNG()
      }
    } catch (error) {
      console.warn('[capture] failed', error)
      this.toast({ id: 'capture', message: 'Couldn’t capture this page', timeout: 3000 })
      return
    }
    png = pngWithDensity(png, scale)
    const image = nativeImage.createFromBuffer(png, { scaleFactor: scale })
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const temp = join(app.getPath('temp'), `Zepper Capture ${stamp}.png`)
    await writeFile(temp, png)
    // Always on the clipboard; full pages (usually long) are saved straight to Downloads too.
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
    const { width, height } = image.getSize()
    this.lastCapture = {
      png,
      temp,
      saved: null,
      name: `Zepper Capture ${stamp}.png`,
      thumbnail: image.resize({ width: Math.min(560, Math.round(width * scale)), quality: 'good' }).toDataURL(),
      size: [Math.round(width * scale), Math.round(height * scale)]
    }
    if (mode === 'full') await this.saveCapture()
    this.showCaptureResult()
  }

  private showCaptureResult(): void {
    const capture = this.lastCapture
    if (!capture) return
    const [width, height] = capture.size
    this.emit({ type: 'capture.result', thumbnail: capture.thumbnail, width, height, saved: capture.saved }, 'overlay')
  }

  private async saveCapture(): Promise<void> {
    const capture = this.lastCapture
    if (!capture || capture.saved) return
    const path = uniquePath(join(this.settings.downloadPath || app.getPath('downloads'), capture.name))
    await writeFile(path, capture.png)
    capture.saved = path
  }

  private captureCommand(command: Extract<Command, { type: `capture.${string}` }>): void {
    const capture = this.lastCapture
    switch (command.type) {
      case 'capture.take':
        return void this.takeCapture(command.mode, command.rect)
      case 'capture.cancel':
        this.captureFrame = null
        return
      case 'capture.retake':
        this.lastCapture = null
        return void this.startCapture()
      case 'capture.dismiss':
        this.lastCapture = null
        return
      case 'capture.save':
        return void this.saveCapture().then(() => this.showCaptureResult())
      case 'capture.reveal':
        if (capture) shell.showItemInFolder(capture.saved ?? capture.temp)
        return
      case 'capture.drag':
        // Drag the capture out into Messages, Mail, Finder…
        if (capture && !this.overlay.webContents.isDestroyed()) {
          this.overlay.webContents.startDrag({ file: capture.temp, icon: nativeImage.createFromBuffer(capture.png).resize({ width: 96 }) })
        }
        return
    }
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
    this.reloadPage(this.activeWebContents(), hard)
  }

  /** Reloads a page; on Zepper's error page, tries the address that failed again. */
  private reloadPage(wc: WebContents | null | undefined, hard = false): void {
    if (!wc || wc.isDestroyed()) return
    const failed = this.errorPages.get(wc.getURL())
    if (failed) wc.loadURL(failed).catch(() => {})
    else if (hard) wc.reloadIgnoringCache()
    else wc.reload()
  }

  zoomActive(direction: 1 | -1 | 0): void {
    const wc = this.activeWebContents()
    if (wc) this.zoomPage(wc, direction)
  }

  /** Zooms a page in Chrome's steps; the level is remembered for its site. */
  private zoomPage(wc: WebContents, direction: 1 | -1 | 0): void {
    const factor = nextZoom(wc.getZoomFactor(), direction)
    wc.setZoomFactor(factor)
    const host = safeHost(wc.getURL())
    if (this.kind !== 'private') this.hub.zoom.set(host, factor)
    this.toast({
      id: 'zoom',
      message: `Zoom ${Math.round(factor * 100)}%`,
      description: host.replace(/^www\./, '') || undefined,
      action: factor !== 1 ? { label: 'Reset', command: { type: 'page.zoom', direction: 0 } } : undefined,
      timeout: 2500
    })
  }

  /** A page opens at the zoom you chose for its site. */
  private applySiteZoom(wc: WebContents, url: string): void {
    if (this.kind === 'private') return
    const factor = this.hub.zoom.get(safeHost(url))
    if (Math.abs(wc.getZoomFactor() - factor) > 0.001) wc.setZoomFactor(factor)
  }

  /** The language pages are translated into: the chosen one, or the Mac's. */
  private translationTarget(): string {
    return (this.settings.translateTo || app.getPreferredSystemLanguages()[0] || 'en').split(/[-_]/)[0].toLowerCase()
  }

  /** Offers translation when a page isn't in your language (and this Mac can translate). */
  private async detectLanguage(tabId: string, wc: WebContents): Promise<void> {
    if (!this.settings.offerTranslation || !this.ai.translation || !/^https?:/.test(wc.getURL())) return
    const page = await wc.executeJavaScriptInIsolatedWorld(ZEPPER_WORLD, [{ code: LANGUAGE_SCRIPT }]).catch(() => null)
    if (!page || wc.isDestroyed()) return
    let language = String(page.lang).split(/[-_]/)[0].toLowerCase()
    // Pages often leave lang unset or wrong: check the text itself.
    if (page.sample.trim().length > 80) {
      const detected = await intelligence.request<{ language: string }>('detect', { text: page.sample }).catch(() => null)
      if (detected?.language) language = detected.language.split(/[-_]/)[0].toLowerCase()
    }
    const tab = this.tab(tabId)
    if (!tab || !language || language === this.translationTarget() || tab.language === language) return
    tab.language = language
    this.broadcast()
  }

  /** Translates the page into your language, or shows the original again. */
  private async translatePage(tabId: string): Promise<void> {
    const tab = this.tab(tabId)
    const wc = this.views.get(tabId)?.webContents
    if (!tab || !wc || wc.isDestroyed()) return
    const run = <T>(code: string): Promise<T> => wc.executeJavaScriptInIsolatedWorld(ZEPPER_WORLD, [{ code }])
    if (tab.translation) {
      this.stopTranslating(tabId)
      await run('window.__zepperTranslator && window.__zepperTranslator.restore()').catch(() => {})
      tab.translation = null
      return this.broadcast()
    }
    let from = tab.language ?? ''
    const to = this.translationTarget()
    tab.translation = 'working'
    this.broadcast()
    const session = Symbol(tabId)
    this.translating.set(tabId, session)
    try {
      await run(TRANSLATOR_SCRIPT)
      await run('window.__zepperTranslator.collect()')
      await run('window.__zepperTranslator.watch()')
      // Translates what's on screen first, then outward from wherever you've scrolled to, as long as
      // the translation is showing. Apple's model takes a moment per line, so long pages fill in over time.
      let first = true
      while (this.translating.get(tabId) === session && !wc.isDestroyed()) {
        await run('window.__zepperTranslator.collectAdded()')
        const batch = await run<{ u: number; segments: string[] }[]>(
          `window.__zepperTranslator.next(${first ? 4 : 16}, ${first ? 900 : 3500})`
        )
        if (batch.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1200))
          continue
        }
        const result = await intelligence.request<{ from: string; units: [number, string][][] }>('translateRich', {
          from,
          to,
          units: batch.map((unit) => unit.segments)
        })
        from ||= result.from
        if (this.translating.get(tabId) !== session) break
        await run(`window.__zepperTranslator.apply(${JSON.stringify(batch.map((unit, k) => [unit.u, result.units[k] ?? []]))})`)
        if (first && this.tab(tabId)) {
          first = false
          this.tab(tabId)!.translation = 'on'
          this.broadcast()
        }
      }
    } catch (error) {
      // Stopped meanwhile (you went to another page, or showed the original): nothing to report.
      if (this.translating.get(tabId) !== session) return
      this.stopTranslating(tabId)
      if (this.tab(tabId)) tab.translation = null
      this.broadcast()
      const code = error instanceof AiError ? error.code : undefined
      const name = (language: string): string => {
        try {
          return (language && new Intl.DisplayNames(['en'], { type: 'language' }).of(language)) || 'the languages'
        } catch {
          return language
        }
      }
      if (code === 'notInstalled') {
        this.toast({
          id: 'translate',
          message: `Download ${name(from)} and ${name(to)} to translate`,
          description: 'System Settings › General › Language & Region › Translation Languages',
          action: { label: 'Open', command: { type: 'app.openTranslationSettings' } },
          timeout: 8000
        })
      } else {
        this.toast({
          id: 'translate',
          message: 'Couldn’t translate this page',
          description: error instanceof Error ? error.message : undefined,
          timeout: 4000
        })
      }
    }
  }

  private stopTranslating(tabId: string): void {
    this.translating.delete(tabId)
  }

  /** The partition of the active space's session, for its extension buttons (none in private windows). */
  private extensionsPartition(): string {
    if (this.kind === 'private') return ''
    const profile = this.space(this.activeSpaceId)?.profile ?? DEFAULT_PROFILE
    return profile === DEFAULT_PROFILE ? BROWSING_PARTITION : `persist:space-${profile}`
  }

  /** What on-device intelligence can do here: nothing when it's turned off in Settings. */
  private get ai(): IntelligenceStatus {
    return this.settings.aiFeatures
      ? this.hub.aiStatus
      : { ai: false, reason: 'Turned off in Settings.', translation: false, embeddings: false }
  }

  /** Remembers what a page is about, for searching history by meaning (not in private windows). */
  private notePage(wc: WebContents): void {
    const url = wc.getURL()
    if (this.kind === 'private' || !this.ai.embeddings || !/^https?:/.test(url) || this.errorPages.has(url)) return
    void wc
      .executeJavaScriptInIsolatedWorld(ZEPPER_WORLD, [{ code: PAGE_TEXT_SCRIPT }])
      .then((page: { title: string; text: string } | null) => {
        if (page && !wc.isDestroyed() && wc.getURL() === url) this.hub.services.semantic.note(url, page.title, page.text.slice(0, 1500))
      })
      .catch(() => {})
  }

  /** The "Ask this page" panel: a summary of the page, and questions about it. */
  openAssistant(anchor?: Rect): void {
    if (!this.ai.ai) return
    const tab = this.tab(this.activeTabId)
    if (!tab || !/^https?:|^file:/.test(tab.url)) return
    const bounds = this.contentBounds()
    this.handle({
      type: 'ui.openPopover',
      popover: {
        kind: 'assistant',
        anchor: anchor ?? { x: bounds.x + bounds.width - 412, y: bounds.y + 4, width: 0, height: 0 },
        title: tab.title,
        host: safeHost(tab.url).replace(/^www\./, '')
      }
    })
  }

  /** Summarises the page (no question) or answers a question about it, streaming to the panel. */
  private async runAssistant(requestId: string, question: string | undefined, history: [string, string][]): Promise<void> {
    const send = (text: string, done: boolean, error?: string): void =>
      this.emit({ type: 'assistant.text', requestId, text, done, error }, 'overlay')
    const tab = this.tab(this.activeTabId)
    const wc = tab && this.views.get(tab.id)?.webContents
    if (!tab || !wc || wc.isDestroyed()) return send('', true, 'Open a page first.')
    const page: { title: string; text: string } | null = await wc
      .executeJavaScriptInIsolatedWorld(ZEPPER_WORLD, [{ code: PAGE_TEXT_SCRIPT }])
      .catch(() => null)
    if (!page?.text.trim()) return send('', true, 'There’s no text on this page to read.')
    try {
      const result = await intelligence.request<{ text: string }>(
        question ? 'ask' : 'summarize',
        { title: page.title, text: page.text, question: question?.slice(0, 500), history: history.slice(-3) },
        (partial) => send(partial, false)
      )
      send(result.text, true)
    } catch (error) {
      send('', true, error instanceof AiError ? error.message : 'Apple Intelligence couldn’t answer that.')
    }
  }

  printActive(): void {
    const wc = this.activeWebContents()
    if (wc) this.printPage(wc)
  }

  /**
   * Prints a page with the system dialog. The page waits while the dialog is open, which isn't it
   * hanging, so the "not responding" prompt stays away until printing is done.
   */
  printPage(wc: WebContents): void {
    if (this.printing.has(wc.id) || wc.isDestroyed()) return
    this.printing.add(wc.id)
    wc.print({}, () => this.printing.delete(wc.id))
  }

  /** File › Save Page As… (complete, or HTML only). */
  async savePageAs(): Promise<void> {
    const wc = this.activeWebContents()
    const tab = this.tab(this.activeTabId)
    if (!wc || !tab) return
    const { canceled, filePath } = await dialog.showSaveDialog(this.win, {
      defaultPath: join(this.settings.downloadPath || app.getPath('downloads'), `${fileNameFor(tab.title)}.html`),
      filters: [
        { name: 'Web Page, Complete', extensions: ['html'] },
        { name: 'Web Page, HTML Only', extensions: ['htm'] }
      ]
    })
    if (canceled || !filePath) return
    try {
      await wc.savePage(filePath, filePath.endsWith('.htm') ? 'HTMLOnly' : 'HTMLComplete')
      this.toast({ id: 'saved-page', message: 'Page saved', description: basename(filePath), timeout: 3000 })
    } catch {
      this.toast({ id: 'saved-page', message: 'Couldn’t save the page', description: basename(filePath), timeout: 4000 })
    }
  }

  /** File › Export as PDF… */
  async exportPdf(): Promise<void> {
    const wc = this.activeWebContents()
    const tab = this.tab(this.activeTabId)
    if (!wc || !tab) return
    const { canceled, filePath } = await dialog.showSaveDialog(this.win, {
      defaultPath: join(this.settings.downloadPath || app.getPath('downloads'), `${fileNameFor(tab.title)}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (canceled || !filePath) return
    try {
      await writeFile(filePath, await wc.printToPDF({ printBackground: true }))
      this.toast({ id: 'saved-page', message: 'Exported as PDF', description: basename(filePath), timeout: 3000 })
    } catch {
      this.toast({ id: 'saved-page', message: 'Couldn’t export the page', description: basename(filePath), timeout: 4000 })
    }
  }

  viewSource(): void {
    const tab = this.tab(this.activeTabId)
    if (tab && /^(https?|file):/.test(tab.url)) this.openTab(`view-source:${tab.url}`, { afterTabId: tab.id })
  }

  /** File › Open File… */
  async openFileDialog(): Promise<void> {
    const { canceled, filePaths } = await dialog.showOpenDialog(this.win, { properties: ['openFile', 'multiSelections'] })
    if (canceled) return
    for (const path of filePaths) this.openTab(pathToFileURL(path).href)
  }

  /** A link or file opened from another app (Zepper as the default browser). */
  openFromOutside(url: string): void {
    this.openTab(url)
    if (this.win.isMinimized()) this.win.restore()
    this.win.show()
  }

  /** Tabs in this window (to warn before quitting windows that aren't restored). */
  tabCount(): number {
    return this.tabs.length
  }

  /** A site asks for a client certificate: you choose (Electron would send the first one silently). */
  async selectClientCertificate(url: string, list: Certificate[], callback: (certificate?: Certificate) => void): Promise<void> {
    const shown = list.slice(0, 6)
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'question',
      message: `${safeHost(url) || 'This site'} wants a certificate to identify you`,
      detail: 'Only choose one if you trust this site. You can also continue without sending one.',
      buttons: [...shown.map((c) => c.subjectName || c.issuerName || 'Certificate'), 'Don’t Send'],
      defaultId: shown.length,
      cancelId: shown.length
    })
    callback(shown[response])
  }

  /** A page stopped responding: wait, or end it (it then shows the crash page with Reload). */
  private async onUnresponsive(tabId: string, wc: WebContents): Promise<void> {
    if (this.hungTabs.has(tabId) || this.windowClosed || this.printing.has(wc.id)) return
    this.hungTabs.add(tabId)
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'warning',
      message: 'Page isn’t responding',
      detail: `${safeHost(this.tab(tabId)?.url ?? '') || 'This page'} has stopped responding. You can wait for it, or close the page.`,
      buttons: ['Wait', 'Close Page'],
      defaultId: 0,
      cancelId: 0
    })
    this.hungTabs.delete(tabId)
    if (response === 1 && !wc.isDestroyed()) wc.forcefullyCrashRenderer()
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
            session: this.sessionFor(tab),
            scrollBounce: true,
            spellcheck: true,
            // Chromium's PDF viewer.
            plugins: true,
            // Zepper's page script runs in iframes too (still sandboxed and isolated): sign-in forms, ad
            // filtering and privacy protections inside embedded frames.
            nodeIntegrationInSubFrames: true,
            // Frames Zepper's dialog shim doesn't reach get a "stop dialogs" option.
            safeDialogs: true
          }
        })
    view.setBorderRadius(this.settings.cornerRadius)
    // Part of fingerprinting protection: WebRTC only uses the public interface, so pages can't learn local addresses.
    view.webContents.setWebRTCIPHandlingPolicy(this.settings.blockFingerprinting ? 'default_public_interface_only' : 'default')
    // Like Chrome: pages without a background of their own are white, in dark mode too
    // (pages that support dark mode paint their own).
    view.setBackgroundColor('#ffffff')
    this.views.set(tab.id, view)
    this.tabByWebContents.set(view.webContents.id, tab.id)
    this.wire(tab.id, view.webContents)
    this.extensions?.apiFor(view.webContents.session)?.addTab(view.webContents, this.win)
    tab.loaded = true
    if (!adopt) void view.webContents.loadURL(tab.url).catch(() => {})
    return view
  }

  /**
   * The session a tab's page lives in: its space's profile (Essentials use the default one).
   * Private windows have their own throwaway session; other windows share the
   * default profile.
   */
  private sessionFor(tab: Tab): Session {
    if (this.kind === 'private') return this.ses
    // Essentials too use their space's sign-ins.
    const profile = tab.spaceId ? (this.space(tab.spaceId)?.profile ?? DEFAULT_PROFILE) : DEFAULT_PROFILE
    return this.hub.profileSession(profile)
  }

  /**
   * After a tab moves to another space (or in or out of Essentials), a page in the wrong
   * profile is reloaded in the right one; a page can't change session.
   */
  private rehome(tab: Tab): void {
    const view = this.views.get(tab.id)
    if (!view || view.webContents.session === this.sessionFor(tab)) return
    const visible = this.attached.has(tab.id)
    this.destroyView(tab)
    if (visible) {
      this.ensureView(tab)
      this.syncAttachedViews()
    }
  }

  /** The session of the page you're looking at (site data and certificate panels). */
  private activeSession(): Session {
    return this.activeWebContents()?.session ?? this.ses
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
    // Zepper and the extensions layer each watch a page's lifetime; more than Node's default ten is expected.
    wc.setMaxListeners(30)
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
      this.extensions?.apiFor(wc.session)?.selectTab(wc)
      this.broadcast()
    })
    // A page with unsaved changes asks before it's left, as in Chrome (Electron would otherwise cancel silently).
    wc.on('will-prevent-unload', (event) => {
      if (this.win.isDestroyed()) return event.preventDefault()
      this.askingToLeave.add(tabId)
      const choice = dialog.showMessageBoxSync(this.win, {
        type: 'question',
        buttons: ['Leave', 'Stay'],
        defaultId: 0,
        cancelId: 1,
        message: 'Leave site?',
        detail: 'Changes you made may not be saved.'
      })
      this.askingToLeave.delete(tabId)
      if (choice === 0) event.preventDefault()
      // Staying cancels a tab close that was waiting for the page.
      else this.closingTabs.delete(tabId)
    })
    // Dialogs belong to the page that asked; a new page (or a closed tab) cancels them.
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return
      this.dropDialogs(tabId)
      // A new page: its language is checked again once it loads, untranslated.
      this.stopTranslating(tabId)
      if (this.tab(tabId)?.language || this.tab(tabId)?.translation) update({ language: null, translation: null })
    })
    wc.once('destroyed', () => this.dropDialogs(tabId))
    wc.on('did-start-loading', () => update({ loading: true }))
    wc.on('did-stop-loading', () => update({ loading: false, ...navState() }))
    wc.on('page-title-updated', (_event, title) => {
      update({ title })
      if (this.tab(tabId)?.media) void this.refreshMedia(tabId, wc)
      if (this.kind !== 'private') this.history.updateTitle(wc.getURL(), title)
    })
    wc.on('page-favicon-updated', (_event, favicons) => {
      const favicon = favicons[0] ?? null
      // A pinned tab pinned before its page loaded learns its icon once it's on its pinned page.
      const tab = this.tab(tabId)
      if (favicon && tab?.pinned && !tab.pinned.favicon && stripHash(tab.url) === stripHash(tab.pinned.url)) tab.pinned.favicon = favicon
      update({ favicon })
    })
    wc.on('did-navigate', (_event, url) => {
      const failed = this.errorPages.get(url)
      if (failed) {
        // Zepper's error page stands in for the address that failed: the tab keeps that address
        // (for the URL bar, reload and restore), and Back skips the failed attempts before it.
        const history = wc.navigationHistory
        for (let i = history.getActiveIndex() - 1; i >= 0; i--) {
          const entry = history.getEntryAtIndex(i)?.url
          if (entry !== failed && this.errorPages.get(entry) !== failed) break
          history.removeEntryAtIndex(i)
        }
        return update({ url: failed, blockedCount: 0, media: null, ...navState() })
      }
      update({ url, blockedCount: 0, media: null, ...navState() })
      this.applySiteZoom(wc, url)
      if (this.kind !== 'private') this.history.record(url, wc.getTitle())
    })
    // In-page address changes are visits once they settle: maps and infinite scroll rewrite the
    // address constantly, and every step would otherwise be a visit.
    let inPageVisit: NodeJS.Timeout | null = null
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      update({ url, ...navState() })
      if (this.kind === 'private') return
      if (inPageVisit) clearTimeout(inPageVisit)
      inPageVisit = setTimeout(() => {
        inPageVisit = null
        if (!wc.isDestroyed() && wc.getURL() === url) this.history.record(url, wc.getTitle())
      }, 2000)
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
      // A typed address goes to HTTPS first; a site without it gets plain HTTP instead of an error.
      const typed = normalizedUrl(url)
      if (this.httpsFirst.delete(typed) && code !== -105 && /^https:/.test(typed)) {
        wc.loadURL(typed.replace(/^https:/, 'http:')).catch(() => {})
        return
      }
      // A plain-HTTP page we upgraded: the site has no (working) HTTPS, so load it as it was.
      const http = this.hub.services.adblock.https.fallback(url, code)
      if (http) {
        wc.loadURL(http).catch(() => {})
        return
      }
      const page = errorPage(url, description, code <= -200 && code > -300 ? 'certificate' : 'network')
      this.errorPages.set(page, url)
      if (this.errorPages.size > 100) this.errorPages.delete(this.errorPages.keys().next().value!)
      wc.loadURL(page).catch(() => {})
    })
    wc.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit' || this.windowClosed) return
      const tab = this.tab(tabId)
      if (!tab || !tab.loaded) return
      // The tab stays, with a page explaining what happened; reloading brings the page back.
      const page = errorPage(tab.url, details.reason === 'oom' ? 'Out of memory' : `Reason: ${details.reason}`, 'crash')
      this.errorPages.set(page, tab.url)
      update({ loading: false, audible: false, media: null })
      wc.loadURL(page).catch(() => {})
    })
    wc.on('unresponsive', () => void this.onUnresponsive(tabId, wc))
    // ⌘-scroll zooms like the menu does; pinch-to-zoom magnifies (Electron turns it off by default).
    wc.on('zoom-changed', (_event, direction) => this.zoomPage(wc, direction === 'in' ? 1 : -1))
    wc.on('did-finish-load', () => {
      void wc.setVisualZoomLevelLimits(1, 3).catch(() => {})
      this.notePage(wc)
      void this.detectLanguage(tabId, wc)
    })
    wc.on('found-in-page', (_event, result) => {
      if (tabId !== this.activeTabId) return
      this.emit({ type: 'find.result', result: { active: result.activeMatchOrdinal, matches: result.matches } }, 'overlay')
    })
    wc.on('context-menu', (_event, params) => this.pageContextMenu(tabId, wc, params))
    wc.setWindowOpenHandler((details) => this.handleWindowOpen(tabId, details))
    const wcId = wc.id
    wc.on('input-event', (_event, input) => {
      if (USER_INPUT.has(input.type)) this.lastInput.set(wcId, Date.now())
    })
    wc.on('did-create-window', (win) => this.adoptPopup(win, tabId))
    wc.once('destroyed', () => this.lastInput.delete(wcId))
  }

  private handleWindowOpen(openerId: string, details: HandlerDetails): WindowOpenHandlerResponse {
    const openerContents = this.views.get(openerId)?.webContents
    // Pop-up blocking: pages open tabs and windows only shortly after a click or key press.
    if (Date.now() - (this.lastInput.get(openerContents?.id ?? -1) ?? 0) > USER_ACTIVATION_MS) {
      if (openerId === this.activeTabId || this.attached.has(openerId)) {
        const real = /^https?:/.test(details.url)
        this.toast({
          id: 'popup-blocked',
          message: 'Pop-up blocked',
          description: safeHost(details.url) || undefined,
          action: real ? { label: 'Open', command: { type: 'tab.open', input: details.url, where: 'new' } } : undefined,
          timeout: 5000
        })
      }
      return { action: 'deny' }
    }
    // Real popups (OAuth, payment flows) keep their own window so window.opener keeps working.
    if (details.disposition === 'new-window' && details.features) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 700,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegrationInSubFrames: true, safeDialogs: true, plugins: true }
        }
      }
    }
    const opener = this.tab(openerId)
    const spaceId = opener?.spaceId ?? this.activeSpaceId
    const probe = makeTab({ kind: 'normal', url: details.url, spaceId })
    if (openerContents && this.sessionFor(probe) !== openerContents.session) {
      // A link from an Essential into a space with its own sign-ins: open it in that space's
      // profile, where the tab lives, rather than carrying the Essential's session along.
      this.insertNormalTab(probe, undefined)
      if (details.disposition === 'background-tab') this.broadcast()
      else this.activateTab(probe.id)
      return { action: 'deny' }
    }
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
    // Players that tick their title every second would ask every second: at most every few seconds.
    const last = this.mediaReadAt.get(tabId) ?? 0
    if (tab.media && Date.now() - last < MEDIA_REFRESH_MS) return
    this.mediaReadAt.set(tabId, Date.now())
    let meta: { title: string; artist: string; artwork: string | null } | null
    try {
      // Reading metadata needs no user gesture, so the page isn't handed one.
      meta = await wc.executeJavaScript(MEDIA_METADATA_SCRIPT, false)
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
    if (remembered && remembered.spaceId === id) {
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

  private async createSpace(name: string, icon: string, theme: SpaceTheme, choice: ProfileChoice): Promise<void> {
    const space = makeSpace(name.trim() || 'Space', icon || '✨', theme)
    // Sign-ins are set up before the space opens, so its first page already has them.
    if (this.kind === 'main') await this.profileFor(choice, space)
    else space.profile = DEFAULT_PROFILE
    const index = this.spaces.findIndex((s) => s.id === this.activeSpaceId)
    this.spaces.splice(index + 1, 0, space)
    this.switchSpace(space.id)
  }

  /** Gives a space the chosen sign-ins: shared with another space, or its own (fresh or copied). */
  private async profileFor(choice: ProfileChoice, space: Space): Promise<void> {
    const from = choice.mode === 'new' ? undefined : this.space(choice.from)
    if (choice.mode === 'share' && from) {
      space.profile = from.profile
      return
    }
    space.profile = randomUUID()
    if (choice.mode === 'copy' && from) await this.copyCookies(from.profile, space.profile)
  }

  /** Changes an existing space's sign-ins; its open pages reload in the new profile. */
  private async setSpaceProfile(id: string, choice: ProfileChoice): Promise<void> {
    const space = this.space(id)
    if (!space || this.kind !== 'main') return
    const previous = space.profile
    await this.profileFor(choice, space)
    if (space.profile === previous) return
    for (const tab of this.tabs.filter((t) => t.spaceId === id)) this.rehome(tab)
    // A profile nothing uses any more is cleared (the default one always stays).
    if (previous !== DEFAULT_PROFILE && !this.spaces.some((s) => s.profile === previous)) void this.clearProfile(previous)
    this.broadcast()
    const label =
      choice.mode === 'share'
        ? `Sharing sign-ins with ${this.space(choice.from)?.name}`
        : choice.mode === 'copy'
          ? 'Copied sign-ins'
          : 'Started fresh'
    this.toast({ id: 'space-profile', message: label, description: space.name })
  }

  /**
   * Seeds a profile with another's cookies, which is how most sites keep you signed in
   * (site storage like localStorage isn't copied).
   */
  private async copyCookies(fromProfile: string, toProfile: string): Promise<void> {
    const source = this.hub.profileSession(fromProfile)
    const target = this.hub.profileSession(toProfile)
    const cookies = await source.cookies.get({})
    await Promise.all(
      cookies.map((c) => {
        const host = (c.domain ?? '').replace(/^\./, '')
        if (!host) return Promise.resolve()
        return target.cookies
          .set({
            url: `${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`,
            name: c.name,
            value: c.value,
            domain: c.hostOnly ? undefined : c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            expirationDate: c.expirationDate,
            sameSite: c.sameSite
          })
          .catch(() => {})
      })
    )
    await target.cookies.flushStore().catch(() => {})
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
    this.folders = this.folders.filter((f) => f.spaceId !== id)
    if (this.activeTabId && !this.tab(this.activeTabId)) this.activeTabId = null
    const wasActive = this.activeSpaceId === id
    this.spaces = this.spaces.filter((s) => s.id !== id)
    // Its own profile goes with it (the default profile is shared, so it stays).
    if (this.kind === 'main' && space.profile !== DEFAULT_PROFILE && !this.spaces.some((s) => s.profile === space.profile)) {
      void this.clearProfile(space.profile)
    }
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
    this.broadcast()
    this.setOverlayMode('full')
    this.overlay.webContents.focus()
    const current = mode === 'current' ? this.tab(this.activeTabId) : undefined
    this.emit({ type: 'palette.open', mode, currentUrl: current?.url ?? null }, 'overlay')
  }

  private closePalette(refocus: boolean): void {
    this.paletteOpen = false
    this.broadcast()
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
    if (this.showingDialog !== null) {
      // A page dialog was covered (command bar, settings…) before it was answered; the page is
      // still waiting, so it comes back.
      this.showingDialog = null
      setTimeout(() => this.showNextDialog(), 150)
    }
    if (!refocus) return
    const wc = this.activeWebContents()
    if (wc) wc.focus()
    else this.win.webContents.focus()
  }

  private setOverlayMode(mode: OverlayMode): void {
    if (mode === 'full') this.autofill?.hide()
    if (mode !== 'peek' && this.peeking && mode !== 'hidden') {
      this.peeking = false
      this.showTrafficLights(!this.compact)
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
    this.showTrafficLights(!this.compact)
    this.animateLayout()
    this.broadcast()
  }

  /**
   * Shows or hides the traffic lights and puts them in the sidebar's top row: the docked
   * sidebar, or the peek card (inset from the window edge). macOS forgets custom positions
   * after visibility and full-screen changes, so the position is applied every time.
   */
  private showTrafficLights(visible: boolean): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.setWindowButtonVisibility(visible)
    if (!visible) return
    const inset = this.peeking ? PEEK_INSET : 0
    this.win.setWindowButtonPosition({ x: TRAFFIC_LIGHTS.x + inset, y: TRAFFIC_LIGHTS.y + inset })
  }

  private endPeek(): void {
    if (this.peekCheck) clearTimeout(this.peekCheck)
    this.peekCheck = null
    this.peeking = false
    this.showTrafficLights(!this.compact)
  }

  /** The overlay starts over (reloaded, or its renderer went away): nothing stays open or covering. */
  private resetOverlay(): void {
    if (this.windowClosed) return
    this.endPeek()
    this.paletteOpen = false
    this.overlayReported = 'hidden'
    this.setOverlayMode('hidden')
    this.broadcast()
  }

  /** Compact mode: float the sidebar over the page while the pointer is at the window edge. */
  private setPeek(show: boolean): void {
    if (!this.compact || !this.settings.compactRevealOnHover) show = false
    if (show === this.peeking) return
    if (show && this.overlayMode === 'full') return
    this.peeking = show
    // Shown once the card has slid in (ui.peekLights), so they never float over the page alone.
    if (!show) this.showTrafficLights(false)
    if (show) {
      this.setOverlayMode('peek')
      this.emit({ type: 'peek.show' }, 'overlay')
      // If the overlay doesn't take it up, don't leave its (invisible) view over the sidebar's edge.
      if (this.peekCheck) clearTimeout(this.peekCheck)
      this.peekCheck = setTimeout(() => {
        this.peekCheck = null
        if (!this.peeking || this.overlayReported === 'peek' || this.overlayReported === 'full') return
        this.endPeek()
        if (this.overlayMode === 'peek') this.setOverlayMode('hidden')
      }, 800)
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
  onPageSwipe(webContentsId: number, phase: 'update' | 'end', rawDx: number, peak: number): void {
    const tabId = this.tabByWebContents.get(webContentsId)
    if (!tabId || !this.settings.swipeToNavigate || this.htmlFullscreen || !this.attached.has(tabId)) return
    const now = Date.now()
    // The momentum tail of a swipe that just navigated lands on the next page looking like a new
    // swipe. Ignore it until the trackpad goes quiet.
    if (this.swipeCooldown?.tabId === tabId && now < this.swipeCooldown.until) {
      this.swipeCooldown.until = now + 250
      return
    }
    const wc = this.views.get(tabId)?.webContents
    if (!wc) return
    if (this.swipeTabId !== tabId) {
      this.swipeTabId = tabId
      readNaturalScrolling()
    }
    // Swipe right is back either way; with natural scrolling off the wheel deltas are mirrored.
    const dx = naturalScrolling ? rawDx : -rawDx
    const direction = dx < 0 ? 'back' : 'forward'
    const allowed = direction === 'back' ? wc.navigationHistory.canGoBack() : wc.navigationHistory.canGoForward()
    const progress = Math.min(1, Math.abs(dx) / SWIPE_DISTANCE)
    // The page itself slides only when it's alone on screen (not in split view).
    const slides = this.attached.size === 1

    if (phase === 'update') {
      this.stopSwipeAnimation()
      const travel = allowed ? 72 * (1 - Math.pow(1 - progress, 3)) : 12 * progress
      this.swipeOffset = slides ? (direction === 'back' ? travel : -travel) : 0
      this.layout()
      this.emit({ type: 'swipe.progress', direction, progress, allowed }, 'chrome')
      return
    }

    this.swipeTabId = null
    this.emit({ type: 'swipe.progress', direction, progress: 0, allowed }, 'chrome')
    const flick = peak >= FLICK_SPEED && Math.abs(dx) >= FLICK_DISTANCE
    if (!allowed || (progress < 1 && !flick)) return this.animateSwipeOffset(0, 220)

    this.swipeCooldown = { tabId, until: now + 400 }
    // Slide a little further, swap pages while the old one is out of the way, then settle back.
    if (slides) this.animateSwipeOffset(direction === 'back' ? 110 : -110, 110)
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(fallback)
      wc.removeListener('did-navigate', settle)
      wc.removeListener('did-navigate-in-page', onInPage)
      wc.removeListener('did-fail-load', settle)
      if (!wc.isDestroyed()) this.animateSwipeOffset(0, 240)
    }
    const onInPage = (_event: unknown, _url: string, isMainFrame: boolean): void => {
      if (isMainFrame) settle()
    }
    const fallback = setTimeout(settle, 650)
    wc.on('did-navigate', settle)
    wc.on('did-navigate-in-page', onInPage)
    wc.on('did-fail-load', settle)
    if (direction === 'back') wc.navigationHistory.goBack()
    else wc.navigationHistory.goForward()
  }

  private stopSwipeAnimation(): void {
    if (this.swipeAnimation) clearTimeout(this.swipeAnimation)
    this.swipeAnimation = null
  }

  /** Eases the swipe offset of the active page to a value. */
  private animateSwipeOffset(to: number, duration: number): void {
    this.stopSwipeAnimation()
    const from = this.swipeOffset
    const start = Date.now()
    const tick = (): void => {
      const t = Math.min(1, (Date.now() - start) / duration)
      this.swipeOffset = from + (to - from) * (1 - Math.pow(1 - t, 3))
      this.layout()
      this.swipeAnimation = t < 1 ? setTimeout(tick, 8) : null
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
      view.setBounds({
        x: lerp(from.x, to.x),
        y: lerp(from.y, to.y),
        width: lerp(from.width, to.width),
        height: lerp(from.height, to.height)
      })
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
    for (const cookie of await this.activeSession().cookies.get({})) {
      const domain = (cookie.domain ?? '').replace(/^\./, '')
      if (domain === site || domain.endsWith(`.${site}`)) counts.set(domain, (counts.get(domain) ?? 0) + 1)
    }
    return [...counts.entries()].map(([domain, cookies]) => ({ domain, cookies })).sort((a, b) => a.domain.localeCompare(b.domain))
  }

  private async clearDomain(domain: string): Promise<void> {
    const ses = this.activeSession()
    const cookies = (await ses.cookies.get({})).filter((c) => (c.domain ?? '').replace(/^\./, '') === domain)
    await Promise.all(
      cookies.map((c) => ses.cookies.remove(`http${c.secure ? 's' : ''}://${domain}${c.path ?? '/'}`, c.name).catch(() => {}))
    )
    await Promise.all(['https', 'http'].map((scheme) => ses.clearStorageData({ origin: `${scheme}://${domain}` }).catch(() => {})))
  }

  private siteInfo(): SiteInfo | null {
    const tab = this.tab(this.activeTabId)
    if (!tab) return null
    let parsed: URL | null
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
      adblockEnabled: this.settings.adblock,
      adblockSite: this.adblock.protects(tab.url),
      siteDomain: parseDomain(tab.url).domain || host,
      protections: PROTECTIONS.map(({ key, label, setting }) => ({
        key,
        label,
        global: this.settings[setting] === true,
        site: this.adblock.protects(tab.url, key)
      })),
      permissions: /^https?:/.test(tab.url) ? this.permissions.list(origin) : []
    }
  }

  private async openSiteInfo(anchor: Rect): Promise<void> {
    const info = this.siteInfo()
    if (!info) return
    if (/^https?:/.test(info.url)) info.siteData = await this.siteData(info.url)
    this.handle({ type: 'ui.openPopover', popover: { kind: 'siteInfo', anchor, info } })
  }

  /**
   * A page asked for Widevine while it's off. Like Brave, offer to turn it on:
   * once per site per session, only for the tab you're looking at.
   */
  onWidevineNeeded(wc: WebContents, _frameHost: string): void {
    const tabId = this.tabByWebContents.get(wc.id)
    const tab = this.tab(tabId)
    if (!tab || this.settings.widevine || !this.settings.widevinePrompt) return
    this.widevineTabs.add(tab.id)
    const site = parseDomain(tab.url).domain || safeHost(tab.url)
    if (this.widevineAsked.has(site) || tab.id !== this.activeTabId || this.overlayMode === 'full') return
    this.widevineAsked.add(site)
    const bounds = this.contentBounds()
    const anchor = { x: bounds.x + 4, y: bounds.y, width: 0, height: 0 }
    this.handle({ type: 'ui.openPopover', popover: { kind: 'widevine', anchor, host: site, restart: this.hub.widevineNeedsRestart() } })
  }

  private respondToWidevine(choice: 'install' | 'later' | 'never'): void {
    if (choice === 'install') {
      this.settingsStore.update({ widevine: true })
      // castLabs' updater can only install it on a fresh launch: restart (you agreed in the prompt).
      if (this.hub.widevine.state === 'restart') return this.hub.relaunch()
      this.toast({ id: 'widevine', message: 'Installing Widevine…', description: 'Downloading it from Google', timeout: 8000 })
    } else if (choice === 'never') {
      this.settingsStore.update({ widevinePrompt: false })
      this.toast({
        id: 'widevine',
        message: 'Zepper won’t ask again',
        description: 'Turn on Widevine any time in Settings → Media.',
        timeout: 4500
      })
    } else {
      this.toast({
        id: 'widevine',
        message: 'Protected video won’t play here',
        description: 'Turn on Widevine any time in Settings → Media.',
        timeout: 3500
      })
    }
  }

  onWidevineReady(): void {
    const waiting = [...this.widevineTabs].filter((id) => this.views.has(id))
    this.widevineTabs.clear()
    for (const id of waiting) this.reloadPage(this.views.get(id)?.webContents)
    if (waiting.length > 0 || this.win.isFocused()) {
      this.toast({
        id: 'widevine',
        message: 'Widevine is ready',
        description: waiting.length > 0 ? 'Reloaded the page that needed it.' : 'Protected video can play now.'
      })
    }
  }

  onWidevineFailed(): void {
    if (this.widevineTabs.size === 0 && !this.win.isFocused()) return
    this.toast({
      id: 'widevine',
      message: 'Couldn’t install Widevine',
      description: 'Check your connection, then try again in Settings → Media.',
      timeout: 5000
    })
  }

  /** Turns ad blocking off (or back on) for one site, then reloads its tabs so it takes effect. */
  /** One protection on or off for one site; its pages reload so it takes effect. */
  private setSiteProtection(domain: string, key: Protection, enabled: boolean): void {
    if (!domain || !PROTECTIONS.some((p) => p.key === key)) return
    const current = (this.settings.siteExceptions[domain] ?? []).filter((k) => k !== key)
    const next = enabled ? current : [...current, key]
    const exceptions = { ...this.settings.siteExceptions }
    if (next.length > 0) exceptions[domain] = next
    else delete exceptions[domain]
    this.settingsStore.update({ siteExceptions: exceptions })
    this.reloadSite(domain)
  }

  private reloadSite(domain: string): void {
    for (const tab of this.tabs) {
      if (!tab.loaded || (parseDomain(tab.url).domain || safeHost(tab.url)) !== domain) continue
      this.reloadPage(this.views.get(tab.id)?.webContents)
    }
  }

  private setSiteAdblock(domain: string, enabled: boolean): void {
    if (!domain) return
    const list = this.settings.adblockAllowlist.filter((d) => d !== domain)
    this.settingsStore.update({ adblockAllowlist: enabled ? list : [...list, domain] })
    this.reloadSite(domain)
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
    const ses = this.activeSession()
    await ses.clearStorageData({ origin })
    await ses.clearCache()
    this.toast({ id: 'site-data-cleared', message: 'Site data cleared', description: safeHost(origin) })
    this.reloadPage(this.activeWebContents())
  }

  /** Shows the oldest pending permission prompt that belongs to the active tab. */
  private showNextPrompt(): void {
    if (this.showingPrompt !== null || this.showingDialog !== null || this.paletteOpen) return
    const prompt = this.prompts.find((p) => !p.tabId || p.tabId === this.activeTabId)
    if (!prompt) return
    this.showingPrompt = prompt.id
    const bounds = this.contentBounds()
    const anchor = { x: bounds.x + 4, y: bounds.y, width: 0, height: 0 }
    const { keys: _keys, tabId: _tabId, webContentsId: _webContentsId, callback: _callback, ...view } = prompt
    this.handle({ type: 'ui.openPopover', popover: { kind: 'permission', anchor, prompt: view } })
  }

  private respondToPrompt(id: number, allow: boolean): void {
    const prompt = this.prompts.find((p) => p.id === id)
    this.prompts = this.prompts.filter((p) => p.id !== id)
    if (this.showingPrompt === id) this.showingPrompt = null
    if (!prompt) return
    const state: PermissionState = allow ? 'allow' : 'block'
    for (const key of prompt.keys) this.permissions.set(prompt.origin, key, state)
    // Requests the decision now covers (queued behind this one) are answered with it.
    const covered = this.prompts.filter((p) => p.origin === prompt.origin && p.keys.every((k) => prompt.keys.includes(k)))
    const answer = (granted: boolean): void => {
      prompt.callback(granted)
      for (const other of covered) other.callback(granted)
    }
    if (allow) this.grant(prompt.keys, answer)
    else answer(false)
    this.prompts = this.prompts.filter((p) => !(p.origin === prompt.origin && p.keys.every((k) => prompt.keys.includes(k))))
    setTimeout(() => {
      this.showNextPrompt()
      this.showNextDialog()
    }, 200)
  }

  // ---------------------------------------------------------------------------
  // Page dialogs and sign-in

  /** A page called alert(), confirm() or prompt(). The page waits until we set event.returnValue. */
  onJsDialog(event: IpcMainEvent, kind: string, message: string, value: string): void {
    const type = kind === 'confirm' || kind === 'prompt' ? kind : 'alert'
    const cancelled = type === 'confirm' ? false : null
    const popup = this.popupWindow(event.sender.id)
    if (popup) {
      // In a popup window, a sheet on that window (there's no text field for prompt()).
      if (type === 'prompt') return void (event.returnValue = null)
      void dialog
        .showMessageBox(popup, {
          message: `${safeHost(event.sender.getURL()) || 'This page'} says`,
          detail: String(message).slice(0, 4000),
          buttons: type === 'confirm' ? ['OK', 'Cancel'] : ['OK'],
          defaultId: 0,
          cancelId: type === 'confirm' ? 1 : 0
        })
        .then(({ response }) => (event.returnValue = type === 'confirm' ? response === 0 : null))
        .catch(() => (event.returnValue = cancelled))
      return
    }
    const tabId = this.tabByWebContents.get(event.sender.id)
    if (!tabId) {
      event.returnValue = cancelled
      return
    }
    const guard = this.dialogGuard.get(tabId) ?? { count: 0, suppressed: false }
    this.dialogGuard.set(tabId, guard)
    if (guard.suppressed) {
      event.returnValue = cancelled
      return
    }
    guard.count++
    let frameUrl = ''
    let embedded = false
    try {
      frameUrl = event.senderFrame?.url ?? ''
      embedded = !!event.senderFrame?.parent
    } catch {
      // The frame went away.
    }
    const spec: JsDialogSpec = {
      id: ++this.dialogSeq,
      kind: type,
      message: String(message).slice(0, 4000),
      defaultValue: String(value).slice(0, 2000),
      host: safeHost(frameUrl || this.tab(tabId)?.url || '') || 'This page',
      embedded,
      offerSuppress: guard.count > 1
    }
    let answered = false
    this.queueDialog(spec.id, tabId, { kind: 'jsDialog', anchor: this.contentBounds(), dialog: spec }, (ok, text) => {
      if (answered) return
      answered = true
      event.returnValue = type === 'confirm' ? ok : type === 'prompt' ? (ok ? text : null) : null
    })
  }

  /** A site or proxy asked for a username and password (HTTP authentication). */
  onLogin(wc: WebContents | null, authInfo: AuthInfo, callback: (username?: string, password?: string) => void): void {
    const tabId = wc ? this.tabByWebContents.get(wc.id) : undefined
    const port = authInfo.port && authInfo.port !== 80 && authInfo.port !== 443 ? `:${authInfo.port}` : ''
    const auth: AuthSpec = { id: ++this.dialogSeq, host: `${authInfo.host}${port}`, realm: authInfo.realm ?? '', isProxy: authInfo.isProxy }
    let answered = false
    this.queueDialog(auth.id, tabId, { kind: 'auth', anchor: this.contentBounds(), auth }, (ok, credentials) => {
      if (answered) return
      answered = true
      if (!ok) return callback()
      const { username, password } = JSON.parse(credentials) as { username: string; password: string }
      callback(username, password)
    })
  }

  private queueDialog(id: number, tabId: string | undefined, popover: PopoverSpec, answer: (ok: boolean, value: string) => void): void {
    this.pendingDialogs.push({ id, tabId, popover, answer })
    this.showNextDialog()
  }

  /** Shows the oldest waiting dialog of a tab you can see; others wait until you switch to their tab. */
  private showNextDialog(): void {
    if (this.showingDialog !== null || this.showingPrompt !== null) return
    const next = this.pendingDialogs.find((d) => !d.tabId || d.tabId === this.activeTabId || this.attached.has(d.tabId))
    if (!next) return
    this.showingDialog = next.id
    this.handle({ type: 'ui.openPopover', popover: { ...next.popover, anchor: this.contentBounds() } })
  }

  private respondToDialog(id: number, ok: boolean, value: string, suppress = false): void {
    const index = this.pendingDialogs.findIndex((d) => d.id === id)
    if (this.showingDialog === id) this.showingDialog = null
    if (index < 0) return
    const [dialog] = this.pendingDialogs.splice(index, 1)
    if (suppress && dialog.tabId) {
      const guard = this.dialogGuard.get(dialog.tabId)
      if (guard) guard.suppressed = true
    }
    dialog.answer(ok, value)
    setTimeout(() => {
      this.showNextDialog()
      this.showNextPrompt()
    }, 150)
  }

  /** A tab navigated away or closed: its waiting dialogs are cancelled so nothing hangs. */
  private dropDialogs(tabId: string): void {
    this.dialogGuard.delete(tabId)
    const dropped = this.pendingDialogs.filter((d) => d.tabId === tabId)
    if (dropped.length === 0) return
    this.pendingDialogs = this.pendingDialogs.filter((d) => d.tabId !== tabId)
    for (const dialog of dropped) dialog.answer(false, '')
    if (dropped.some((d) => d.id === this.showingDialog)) {
      this.showingDialog = null
      this.handle({ type: 'ui.dismissOverlay' })
      setTimeout(() => this.showNextDialog(), 150)
    }
  }

  private dropPrompts(match: (prompt: PendingPrompt) => boolean): void {
    for (const prompt of this.prompts.filter(match)) prompt.callback(false)
    this.prompts = this.prompts.filter((p) => !match(p))
  }

  openFind(): void {
    // Not over a page dialog or permission prompt, which need the whole overlay.
    if (!this.activeWebContents() || this.showingDialog !== null || this.showingPrompt !== null) return
    this.emit({ type: 'find.open' }, 'overlay')
    this.setOverlayMode('corner')
    this.overlay.webContents.focus()
  }

  findAgain(forward: boolean): void {
    if (this.lastFindText) this.find(this.lastFindText, forward, true)
  }

  private find(text: string, forward: boolean, again: boolean): void {
    const wc = this.activeWebContents()
    if (!wc) return
    this.lastFindText = text
    if (!text) {
      wc.stopFindInPage('clearSelection')
      this.emit({ type: 'find.result', result: { active: 0, matches: 0 } }, 'overlay')
      return
    }
    // Electron's findNext starts a new search; ours means "the next match of the same text".
    wc.findInPage(text, { forward, findNext: !again })
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
    const essentialsFull = this.essentialsOf(tab.spaceId ?? this.activeSpaceId).length >= MAX_ESSENTIALS
    const changed = !!tab.pinned && stripHash(tab.url) !== stripHash(tab.pinned.url)
    const otherSpaces = this.spaces.filter((s) => s.id !== tab.spaceId)
    const items: MenuItemConstructorOptions[] = []

    if (tab.loaded) items.push({ label: 'Reload Tab', click: () => this.reloadPage(this.views.get(id)?.webContents) })
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
    items.push(...this.folderMenuItems(tab))
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
    if (otherSpaces.length > 0) {
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
      { label: 'Rename Space', click: () => this.emitToSidebars({ type: 'space.startRename', spaceId: id }) },
      { label: 'Change Icon…', click: () => this.handle({ type: 'ui.openPopover', popover: { kind: 'emoji', spaceId: id, anchor } }) },
      { label: 'Edit Theme…', click: () => this.handle({ type: 'ui.openPopover', popover: { kind: 'theme', spaceId: id, anchor } }) },
      { type: 'separator' },
      { label: 'New Folder', click: () => this.createFolder(id, null) },
      { label: 'Unload Space', click: () => this.unloadSpace(id) },
      ...(this.kind === 'main' ? this.profileMenuItems(space) : []),
      { type: 'separator' },
      { label: 'Create Space', click: () => this.handle({ type: 'ui.createSpace' }) },
      { label: 'Delete Space', enabled: this.spaces.length > 1, click: () => void this.deleteSpace(id) }
    ])
  }

  /** "Sign-ins ▸": keep separate, share with or copy from another space, or clear this space's data. */
  private profileMenuItems(space: Space): MenuItemConstructorOptions[] {
    const others = this.spaces.filter((s) => s.id !== space.id)
    const sharing = others.filter((s) => s.profile === space.profile)
    const choose = (profile: ProfileChoice) => () => void this.setSpaceProfile(space.id, profile)
    return [
      {
        label: 'Sign-ins',
        submenu: [
          {
            label: sharing.length > 0 ? `Shared with ${sharing.map((s) => s.name).join(', ')}` : 'Separate from other spaces',
            enabled: false
          },
          { type: 'separator' },
          { label: 'Start Fresh (Separate)', click: choose({ mode: 'new' }) },
          ...(others.length > 0
            ? ([
                {
                  label: 'Share With',
                  submenu: others.map((s) => ({
                    label: `${s.icon}  ${s.name}`,
                    type: 'checkbox',
                    checked: s.profile === space.profile,
                    click: choose({ mode: 'share', from: s.id })
                  }))
                },
                {
                  label: 'Copy From',
                  submenu: others.map((s) => ({ label: `${s.icon}  ${s.name}`, click: choose({ mode: 'copy', from: s.id }) }))
                }
              ] satisfies MenuItemConstructorOptions[])
            : []),
          { type: 'separator' },
          { label: 'Clear Space Data…', click: () => void this.confirmClearSpaceData(space.id) }
        ]
      }
    ]
  }

  private async chooseDownloadFolder(): Promise<void> {
    const { canceled, filePaths } = await dialog.showOpenDialog(this.win, {
      title: 'Save downloads to',
      defaultPath: this.settings.downloadPath || app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (!canceled && filePaths[0]) this.settingsStore.update({ downloadPath: filePaths[0] })
  }

  private async removeExtension(id: string): Promise<void> {
    const info = this.extensions?.list().find((e) => e.id === id)
    if (!info) return
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'warning',
      message: `Remove “${info.name}”?`,
      detail: 'Its data and settings are deleted. You can add it again from the Chrome Web Store.',
      buttons: ['Remove', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    if (response === 0) await this.extensions?.remove(id)
  }

  private async openAbout(): Promise<void> {
    const info = {
      version: app.getVersion(),
      chromium: process.versions.chrome,
      electron: process.versions.electron,
      node: process.versions.node,
      v8: process.versions.v8,
      widevine: this.hub.widevine,
      filtersUpdatedAt: await this.adblock.filtersUpdatedAt()
    }
    this.setOverlayMode('full')
    this.overlay.webContents.focus()
    this.emit({ type: 'about.open', info }, 'overlay')
  }

  private async confirmClearSpaceData(id: string): Promise<void> {
    const space = this.space(id)
    if (!space) return
    const sharedWith = [
      ...this.spaces.filter((s) => s.id !== id && s.profile === space.profile).map((s) => s.name),
      ...(space.profile === DEFAULT_PROFILE ? ['Essentials and extensions'] : [])
    ]
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'warning',
      message: `Clear cookies and site data in “${space.name}”?`,
      detail:
        sharedWith.length > 0
          ? `This space shares its sign-ins with ${sharedWith.join(', ')}; you’ll be signed out there too. History is kept.`
          : 'You’ll be signed out of sites in this space. Other spaces and your history aren’t affected.',
      buttons: ['Clear Data', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    if (response !== 0) return
    await this.clearProfile(space.profile)
    for (const tab of this.tabs) {
      if (tab.loaded && this.sessionFor(tab) === this.hub.profileSession(space.profile))
        this.reloadPage(this.views.get(tab.id)?.webContents)
    }
    this.toast({ id: 'space-data-cleared', message: 'Space data cleared', description: space.name })
  }

  private async clearProfile(profile: string): Promise<void> {
    // Just the profile's storage: not set up as a browsing session (extensions and all) only to be cleared.
    const ses = profile === DEFAULT_PROFILE ? session.defaultSession : session.fromPartition(`persist:space-${profile}`)
    await ses.clearStorageData().catch(() => {})
    await ses.clearCache().catch(() => {})
  }

  /** "Open Link in Space ▸": the other spaces; the link opens there in the background. */
  private openInSpaceItems(url: string, currentSpaceId: string | null): MenuItemConstructorOptions[] {
    const others = this.spaces.filter((space) => space.id !== currentSpaceId)
    if (others.length === 0) return []
    return [
      {
        label: 'Open Link in Space',
        submenu: others.map((space) => ({
          label: `${space.icon}  ${space.name}`,
          click: () => {
            this.openTab(url, { background: true, spaceId: space.id })
            this.toast({
              id: 'opened-in-space',
              message: `Opened in ${space.name}`,
              description: safeHost(url),
              action: { label: 'Switch', command: { type: 'space.switch', spaceId: space.id } },
              timeout: 3000
            })
          }
        }))
      }
    ]
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
        ...this.openInSpaceItems(params.linkURL, tab?.spaceId ?? null),
        // From a private window, links stay private.
        {
          label: 'Open Link in New Window',
          click: () => void this.hub.openWindow(this.kind === 'private' ? 'private' : 'blank', params.linkURL)
        },
        { label: 'Open Link in Private Window', click: () => void this.hub.openWindow('private', params.linkURL) },
        { type: 'separator' },
        { label: 'Save Link As…', click: () => wc.downloadURL(params.linkURL) },
        { label: 'Copy Link', click: () => clipboard.writeText(stripTracking(params.linkURL)) },
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
    if ((params.mediaType === 'video' || params.mediaType === 'audio') && params.srcURL && !params.srcURL.startsWith('blob:')) {
      const noun = params.mediaType === 'video' ? 'Video' : 'Audio'
      items.push(
        { label: `Open ${noun} in New Tab`, click: () => this.openTab(params.srcURL, { background: true, afterTabId: tabId }) },
        { label: `Copy ${noun} Address`, click: () => clipboard.writeText(params.srcURL) },
        { label: `Save ${noun} As…`, click: () => wc.downloadURL(params.srcURL) },
        { type: 'separator' }
      )
    }
    if (params.misspelledWord) {
      items.push(
        { label: 'Add to Dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
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
        // For fields that block pasting: types the clipboard in, so the page's paste handler never sees it.
        {
          label: 'Force Paste',
          enabled: params.editFlags.canPaste,
          click: async () => {
            const text = await clipboard.readText()
            if (text && !wc.isDestroyed()) await wc.insertText(text)
          }
        },
        { role: 'selectAll' },
        { type: 'separator' }
      )
    } else if (params.selectionText.trim()) {
      const text = params.selectionText.trim()
      const short = text.length > 24 ? `${text.slice(0, 24)}…` : text
      items.push(
        { role: 'copy' },
        { label: `Search ${searchEngineName()} for “${short}”`, click: () => this.openTab(searchUrl(text), { afterTabId: tabId }) },
        { type: 'separator' }
      )
    }
    if (!params.linkURL && !params.isEditable && !params.selectionText.trim() && params.mediaType === 'none') {
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => this.reloadPage(wc) },
        { type: 'separator' },
        ...(this.ai.ai ? [{ label: 'Summarise Page', click: () => this.openAssistant() }] : []),
        ...(tab?.translation
          ? [{ label: 'Show Original', click: () => void this.translatePage(tabId) }]
          : this.ai.translation && /^https?:/.test(wc.getURL())
            ? [
                {
                  label: `Translate to ${new Intl.DisplayNames(['en'], { type: 'language' }).of(this.translationTarget()) ?? 'Your Language'}`,
                  click: () => void this.translatePage(tabId)
                }
              ]
            : []),
        { label: 'Save Page As…', click: () => void this.savePageAs() },
        { label: 'Print…', click: () => this.printPage(wc) },
        {
          label: 'View Page Source',
          enabled: /^(https?|file):/.test(wc.getURL()),
          click: () => this.openTab(`view-source:${wc.getURL()}`, { afterTabId: tabId })
        },
        { type: 'separator' }
      )
    }
    const extensionItems = this.extensions?.apiFor(wc.session)?.getContextMenuItems(wc, params) ?? []
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
    // Compact mode keeps a sliver at the sidebar's edge for the hover reveal, even with no gap.
    const edge = this.settings.compactRevealOnHover ? Math.max(gap, MIN_REVEAL_EDGE) : gap
    const sidebar = this.compact ? edge : this.sidebarWidth
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
    if (tab.spaceId !== active.spaceId && active.spaceId) this.setTabSpace(tab, active.spaceId)
    this.rehome(tab)
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
    const peekWidth = this.sidebarWidth + PEEK_AREA_EXTRA
    const right = this.settings.sidebarPosition === 'right'
    this.overlay.setBounds(
      this.overlayMode === 'full'
        ? { x: 0, y: 0, width, height }
        : this.overlayMode === 'peek'
          ? { x: right ? width - peekWidth : 0, y: 0, width: peekWidth, height }
          : { x: width - this.cornerSize.width, y: 0, width: this.cornerSize.width, height: Math.min(height, this.cornerSize.height) }
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
      widevine: this.hub.widevine,
      downloads: this.hub.downloads.list(this.kind === 'private'),
      paletteOpen: this.paletteOpen,
      folders: this.folders,
      tidy: this.settings.aiFeatures ? this.hub.tidy : { kind: 'site', reason: 'Apple Intelligence features are turned off in Settings.' },
      defaultBrowser: this.hub.defaultBrowser,
      intelligence: this.ai,
      extensionsPartition: this.extensionsPartition(),
      windowSize: this.win && !this.win.isDestroyed() ? this.windowBounds() : { width: 0, height: 0, x: 0, y: 0 },
      splits: this.splits,
      panes: this.win && !this.win.isDestroyed() ? this.panes() : []
    }
  }

  /** Coalesces state changes into at most one snapshot per frame for both renderers. */
  /** Shared state changed elsewhere (e.g. Widevine): send a fresh snapshot. */
  refresh(): void {
    this.broadcast()
  }

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

  /** Events for the sidebar go to both copies: the docked one and the floating one in compact mode. */
  private emitToSidebars(event: UiEvent): void {
    this.emit(event, 'chrome')
    this.emit(event, 'overlay')
  }

  private emit(event: UiEvent, target: 'chrome' | 'overlay'): void {
    // Downloads and other late events can arrive after the window has closed.
    if (this.windowClosed) return
    const wc = target === 'chrome' ? this.win.webContents : this.overlay.webContents
    if (!wc.isDestroyed()) wc.send(IPC.event, event)
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
      splits: this.splits,
      folders: this.folders,
      window:
        this.win && !this.win.isDestroyed() ? { bounds: this.win.getNormalBounds(), maximized: this.win.isMaximized() } : this.savedWindow
    }
  }
}

function evenSizes(n: number): number[] {
  return n <= 1 ? [0.5] : Array.from({ length: n }, () => 1 / n)
}

/**
 * Pane rectangles for a split. Horizontal = side by side, vertical = stacked,
 * grid = 3 (A over B | C) and 4 (2×2) layouts.
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
    rects.push(
      vertical ? { x: b.x, y: b.y + start, width: b.width, height: length } : { x: b.x + start, y: b.y, width: length, height: b.height }
    )
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

const ERROR_PAGES = {
  network: { title: 'Can’t reach this page', text: '' },
  certificate: {
    title: 'Your connection isn’t private',
    text: 'Zepper couldn’t confirm this site’s identity, so it didn’t load the page. Someone could be trying to intercept your connection, or the site is set up incorrectly.'
  },
  crash: { title: 'This page crashed', text: 'Reload the page (⌘R) to try again.' }
}

/** A URL in its canonical form (so typed and loaded addresses compare equal). */
function normalizedUrl(url: string): string {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

/** A title made safe to use as a file name. */
function fileNameFor(title: string): string {
  return (
    (title || 'Page')
      .replace(/[/\\:*?"<>|]+/g, '-')
      .trim()
      .slice(0, 100) || 'Page'
  )
}

function errorPage(url: string, description: string, kind: keyof typeof ERROR_PAGES = 'network'): string {
  const escape = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
  const { title, text } = ERROR_PAGES[kind]
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
  :root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: light-dark(#fafafa, #1c1c1e); color: light-dark(#333, #ddd); }
  main { max-width: 440px; padding: 24px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0 0 6px; opacity: .7; line-height: 1.5; word-break: break-all; }
  p.text { opacity: .85; word-break: normal; margin-bottom: 12px; }
  code { font-size: 12px; opacity: .6; }
</style>
<main><h1>${title}</h1>${text ? `<p class="text">${text}</p>` : ''}<p>${escape(url)}</p><code>${escape(description)}</code></main>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
