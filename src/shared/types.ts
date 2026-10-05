// State and IPC contract shared by the main process and both renderers.

import type { Settings } from './settings'

export type TabKind = 'essential' | 'pinned' | 'normal'

/** The URL a pinned tab or Essential snaps back to. */
export interface PinnedInfo {
  url: string
  title: string
  favicon: string | null
}

export interface Tab {
  id: string
  kind: TabKind
  /** Owning space; null for Essentials, which are shared by every space. */
  spaceId: string | null
  url: string
  title: string
  favicon: string | null
  pinned: PinnedInfo | null
  /** Whether the tab currently has a live web view. */
  loaded: boolean
  loading: boolean
  audible: boolean
  muted: boolean
  canGoBack: boolean
  canGoForward: boolean
  lastActiveAt: number
  blockedCount: number
  /** Media this tab has played since its last navigation; drives the now-playing card. */
  media: MediaInfo | null
}

export interface MediaInfo {
  title: string
  artist: string
  artwork: string | null
}

export type Harmony = 'floating' | 'complementary' | 'singleAnalogous' | 'analogous' | 'triadic' | 'splitComplementary'

export interface SpaceTheme {
  /** 0–3 hex colours; empty means the default (vibrancy only) theme. */
  colors: string[]
  /** Gradient strength, 0.2–0.9. */
  opacity: number
  /** Grain overlay strength, 0–1. */
  texture: number
  /** Editor state: dot positions on the colour wheel, normalised to -1..1, primary first. */
  dots?: { x: number; y: number }[]
  harmony?: Harmony
  /** Chrome appearance for this space. Auto picks light or dark from the gradient. */
  scheme?: 'auto' | 'light' | 'dark'
}

export interface Space {
  id: string
  name: string
  icon: string
  theme: SpaceTheme
  collapsedPins: boolean
  lastTabId: string | null
}

export interface Snapshot {
  spaces: Space[]
  tabs: Tab[]
  activeSpaceId: string
  activeTabId: string | null
  sidebarWidth: number
  compact: boolean
  focused: boolean
  fullscreen: boolean
  adblockEnabled: boolean
  settings: Settings
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type Suggestion =
  | { kind: 'url'; url: string; title: string }
  | { kind: 'search'; query: string; url: string; fromProvider: boolean }
  | { kind: 'tab'; tabId: string; url: string; title: string; favicon: string | null }
  | { kind: 'history'; url: string; title: string }

export interface ToastSpec {
  id: string
  message: string
  description?: string
  action?: { label: string; command: Command }
  timeout?: number
}

export type PermissionState = 'allow' | 'block' | 'ask'

export interface CertificateInfo {
  subject: string
  issuer: string
  validFrom: number
  validTo: number
  fingerprint: string
}

export interface NameField {
  label: string
  value: string
}

/** One certificate in a chain, parsed for the certificate viewer. */
export interface CertificateEntry {
  commonName: string
  subject: NameField[]
  issuer: NameField[]
  serialNumber: string
  validFrom: number
  validTo: number
  sha256: string
  sha1: string
  altNames: string[]
  publicKey: string
  signatureAlgorithm: string
  isCA: boolean
}

export interface CertificateChain {
  host: string
  trusted: boolean
  /** Leaf first, root last. */
  entries: CertificateEntry[]
}

export interface SiteInfo {
  url: string
  origin: string
  host: string
  secure: boolean
  /** Scheme without a certificate (http, file, about…). */
  insecureReason: string | null
  certificate: CertificateInfo | null
  chain: CertificateChain | null
  blockedCount: number
  adblockEnabled: boolean
  permissions: { permission: string; label: string; state: PermissionState }[]
}

export interface PermissionPrompt {
  id: number
  origin: string
  host: string
  /** Human readable, e.g. "Use your camera and microphone". */
  label: string
}

export type PopoverSpec =
  | { kind: 'emoji'; spaceId: string; anchor: Rect }
  | { kind: 'theme'; spaceId: string; anchor: Rect }
  | { kind: 'siteInfo'; anchor: Rect; info: SiteInfo }
  | { kind: 'permission'; anchor: Rect; prompt: PermissionPrompt }

export interface FindResult {
  active: number
  matches: number
}

/**
 * Which part of the window the transparent overlay view needs to cover:
 * nothing, the top-right corner (toasts and the find bar), or everything
 * (palette and popovers).
 */
export type OverlayMode = 'hidden' | 'corner' | 'peek' | 'full'

export type Command =
  | { type: 'tab.activate'; tabId: string }
  | { type: 'tab.close'; tabId: string }
  | { type: 'tab.middleClick'; tabId: string }
  | { type: 'tab.open'; input: string; where: 'new' | 'current' }
  | { type: 'tab.pin'; tabId: string }
  | { type: 'tab.unpin'; tabId: string }
  | { type: 'tab.addEssential'; tabId: string }
  | { type: 'tab.removeEssential'; tabId: string }
  | { type: 'tab.resetPinned'; tabId: string; separate?: boolean }
  | { type: 'tab.unload'; tabId: string }
  | { type: 'tab.toggleMute'; tabId: string }
  | { type: 'tab.contextMenu'; tabId: string }
  | { type: 'tab.reopenClosed' }
  | { type: 'nav.back' }
  | { type: 'nav.forward' }
  | { type: 'nav.reload' }
  | { type: 'space.switch'; spaceId: string }
  | { type: 'space.switchRelative'; delta: number }
  | { type: 'space.create'; name: string; icon: string; theme: SpaceTheme }
  | {
      type: 'space.update'
      spaceId: string
      patch: Partial<Pick<Space, 'name' | 'icon' | 'theme' | 'collapsedPins'>>
    }
  | { type: 'space.contextMenu'; spaceId: string; anchor: Rect }
  | { type: 'space.clearTabs'; spaceId: string }
  | { type: 'ui.setSidebarWidth'; width: number }
  | { type: 'ui.openPalette'; mode: 'new' | 'current' }
  | { type: 'ui.closePalette'; refocus: boolean }
  | { type: 'ui.overlayMode'; mode: OverlayMode }
  | { type: 'ui.openPopover'; popover: PopoverSpec }
  | { type: 'ui.copyUrl'; markdown?: boolean }
  | { type: 'ui.newMenu'; anchor: Rect }
  | { type: 'ui.settingsMenu'; anchor: Rect }
  | { type: 'ui.toggleCompact' }
  | { type: 'ui.siteInfo'; anchor: Rect }
  | { type: 'site.exportCertificate'; index: number }
  | { type: 'clipboard.write'; text: string }
  | { type: 'media.toggle'; tabId: string }
  | { type: 'media.dismiss'; tabId: string }
  | { type: 'site.setPermission'; origin: string; permission: string; state: PermissionState }
  | { type: 'site.clearData'; origin: string }
  | { type: 'permission.respond'; id: number; allow: boolean }
  | { type: 'find.query'; text: string; forward: boolean; findNext: boolean }
  | { type: 'find.stop' }
  | { type: 'download.show'; path: string }
  | { type: 'settings.update'; patch: Partial<Settings> }
  | { type: 'ui.openSettings' }
  | { type: 'ui.peekSidebar'; show: boolean }
  | { type: 'ui.dismissOverlay' }

/** Events pushed from the main process to renderers. */
export type UiEvent =
  | { type: 'palette.open'; mode: 'new' | 'current'; currentUrl: string | null }
  | { type: 'toast'; toast: ToastSpec }
  | { type: 'space.startRename'; spaceId: string }
  | { type: 'space.startCreate' }
  | { type: 'popover.open'; popover: PopoverSpec }
  | { type: 'find.open' }
  | { type: 'find.result'; result: FindResult }
  | { type: 'settings.open' }
  | { type: 'peek.show' }
  | { type: 'overlay.dismiss' }
  | { type: 'swipe.progress'; direction: 'back' | 'forward'; progress: number; allowed: boolean }

export interface ZepperApi {
  platform: string
  getSnapshot(): Promise<Snapshot>
  onSnapshot(callback: (snapshot: Snapshot) => void): () => void
  onEvent(callback: (event: UiEvent) => void): () => void
  send(command: Command): void
  suggest(text: string): Promise<Suggestion[]>
}

export const IPC = {
  swipe: 'zepper:swipe',
  snapshot: 'zepper:snapshot',
  getSnapshot: 'zepper:get-snapshot',
  event: 'zepper:event',
  command: 'zepper:command',
  suggest: 'zepper:suggest'
} as const
