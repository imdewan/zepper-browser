// State and IPC contract shared by the main process and both renderers.

import type { Protection, Settings } from './settings'

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
  /** The space the tab belongs to (Essentials too). */
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
  /** When the tab last started or stopped making sound; the most recent media gets the now-playing card. */
  audibleAt: number
  /** The page's language when it isn't yours and can be translated on the Mac (e.g. "ja"). */
  language: string | null
  /** The page is being translated, or shows a translation. */
  translation: 'working' | 'on' | null
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
  /** The pinned area, top level: pinned tab ids and folder ids, in order. */
  pinnedItems: string[]
  /**
   * Where this space keeps cookies, logins, storage and cache:
   * 'default' (shared with Essentials and extensions) or its own store. History is shared.
   */
  profile: string
  /** When you last dismissed the "tabs you haven't opened lately" suggestion here. */
  staleDismissedAt?: number
}

/** A folder in a space's pinned area; folders nest. `items` are tab and folder ids in order. */
export interface Folder {
  id: string
  spaceId: string
  name: string
  collapsed: boolean
  items: string[]
}

/** Where a dragged tab or folder lands. Indexes count the target list as it was before the drag. */
export type DropTarget =
  | { zone: 'pinned'; spaceId: string; parentId: string | null; index: number }
  | { zone: 'normal'; spaceId: string; index: number }
  | { zone: 'essentials'; spaceId: string; index: number }
  | { zone: 'space'; spaceId: string }

/**
 * A space's sign-ins: a fresh profile, a fresh profile seeded with another space's cookies
 * (starts signed in, stays separate), or the same profile as another space (always in sync).
 */
export type ProfileChoice = { mode: 'new' } | { mode: 'copy' | 'share'; from: string }

export type SplitLayout = 'horizontal' | 'vertical' | 'grid'

/** Tabs shown side by side in the content area. */
export interface Split {
  id: string
  tabIds: string[]
  layout: SplitLayout
  /** Fractions along the main axis (horizontal/vertical) or the left column width (grid). */
  sizes: number[]
}

export interface Pane {
  tabId: string
  rect: Rect
}

/** A download, for the downloads panel. */
export interface DownloadEntry {
  id: string
  filename: string
  url: string
  path: string
  state: 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted'
  received: number
  /** 0 when the size isn't known. */
  total: number
  startedAt: number
  /** From a private window: only shown there, never saved. */
  private: boolean
}

/** Google Widevine (DRM): not in this build, turned off, downloading, usable, or failed to install. */
export interface WidevineStatus {
  /** 'restart': turned on, but castLabs' updater can only install it on the next launch. */
  state: 'unavailable' | 'off' | 'restart' | 'installing' | 'ready' | 'error'
  version: string | null
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
  /** Window type: the main window, a temporary window, or a private window. */
  kind: 'main' | 'blank' | 'private'
  widevine: WidevineStatus
  downloads: DownloadEntry[]
  folders: Folder[]
  /** How Tidy groups tabs here: Apple Intelligence, or by site (with why). */
  tidy: { kind: 'ai' } | { kind: 'site'; reason: string }
  /** Zepper opens links from other apps. */
  defaultBrowser: boolean
  /** The session partition whose extensions the UI shows (the active space's); empty in private windows. */
  extensionsPartition: string
  /** What Apple's on-device intelligence can do on this Mac. */
  intelligence: IntelligenceStatus
  /** The command bar is open (the empty page steps back while it is). */
  paletteOpen: boolean
  /** Window content size, so floating UI can line up with the window's background. */
  windowSize: { width: number; height: number }
  splits: Split[]
  /** Where each visible web view sits in the window; more than one while a split is shown. */
  panes: Pane[]
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
  | { kind: 'tab'; tabId: string; url: string; title: string; favicon: string | null; group?: 'recent'; completion?: string }
  /** completion: the site this beginning of an address completes to (the top hit); group: frequently visited. */
  | { kind: 'history'; url: string; title: string; completion?: string; group?: 'frequent' }
  /** A DuckDuckGo bang: a query to send (url set), or a completion for the bang being typed (url null). */
  | { kind: 'bang'; trigger: string; name: string; domain: string; query: string; url: string | null }

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

export interface IntelligenceStatus {
  /** Apple Intelligence (summaries, answers, Tidy Tabs). */
  ai: boolean
  /** Why it isn't available. */
  reason?: string
  /** On-device translation. */
  translation: boolean
  /** On-device text embeddings (search history by meaning). */
  embeddings: boolean
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
  /** Domains under this site that store cookies or data on this device. */
  siteData: { domain: string; cookies: number }[]
  blockedCount: number
  /** Ad blocking is on globally. */
  adblockEnabled: boolean
  /** Ad blocking is on for this site (not on the allowlist). */
  adblockSite: boolean
  /** The site the per-site switch applies to, e.g. youtube.com. */
  siteDomain: string
  /** Each protection: on in Settings, and on for this site. */
  protections: { key: Protection; label: string; global: boolean; site: boolean }[]
  permissions: { permission: string; label: string; state: PermissionState }[]
}

/** A page's alert(), confirm() or prompt(), shown in Zepper's own dialog. */
export interface JsDialogSpec {
  id: number
  kind: 'alert' | 'confirm' | 'prompt'
  message: string
  defaultValue: string
  host: string
  /** Asked by an embedded frame rather than the page itself. */
  embedded: boolean
  /** The page has shown dialogs before: offer to block more. */
  offerSuppress: boolean
}

/** A site (or proxy) asking for a username and password (HTTP authentication). */
export interface AuthSpec {
  id: number
  host: string
  realm: string
  isProxy: boolean
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
  | { kind: 'extensions'; anchor: Rect }
  | { kind: 'spaces'; anchor: Rect }
  | { kind: 'widevine'; anchor: Rect; host: string; restart: boolean }
  | { kind: 'jsDialog'; anchor: Rect; dialog: JsDialogSpec }
  | { kind: 'auth'; anchor: Rect; auth: AuthSpec }
  | { kind: 'assistant'; anchor: Rect; title: string; host: string }

/** A saved login offered under a sign-in field. Never carries the password itself. */
export interface SavedLogin {
  id: string
  username: string
  /** The site it was saved for (its host). */
  site: string
}

/** A row in the dropdown under a sign-in field. */
export type AutofillItem =
  | ({ kind: 'login' } & SavedLogin)
  /** A passkey the page is waiting to accept (passkey autofill). */
  | { kind: 'passkey'; id: string; username: string; site: string }
  /** A strong password to use for a new account. */
  | { kind: 'generate'; password: string }

/** What Zepper's password popup shows. */
export type AutofillState =
  | { kind: 'list'; host: string; items: AutofillItem[] }
  /** After signing in with a new or changed password. */
  | { kind: 'save'; host: string; username: string; update: boolean }
  /** A suggested password was saved. */
  | { kind: 'saved'; host: string; username: string }
  /** A site wants to create a passkey (other: macOS's passkeys can be offered too). */
  | { kind: 'passkeyCreate'; rpId: string; userName: string; other: boolean }
  /** A site wants you to sign in with a passkey. */
  | { kind: 'passkeyGet'; rpId: string; passkeys: { id: string; userName: string; displayName: string }[]; other: boolean }

/** A saved password, as Settings lists it (never with the password). */
export interface LoginSummary {
  id: string
  origin: string
  host: string
  username: string
  note: string
  updated: number
  lastUsed: number | null
}

/** A saved passkey, as Settings lists it. */
export interface PasskeySummary {
  id: string
  rpId: string
  userName: string
  displayName: string
  created: number
  lastUsed: number | null
}

/** A browser on this Mac whose passwords can be imported. */
export interface ImportSource {
  id: string
  name: string
  profiles: { dir: string; name: string }[]
  /** macOS keeps its data from other apps until you allow Zepper (Full Disk Access). */
  blocked?: boolean
}

export interface ImportResult {
  added: number
  /** Already saved, with the same password. */
  skipped: number
  /** Already saved with a different password (Zepper's is kept). */
  conflicts: number
  /** Not a web login (or no password). */
  invalid: number
}

/** Settings › Passwords asks main for these. */
export type VaultRequest =
  | { type: 'list' }
  | { type: 'reveal'; id: string }
  | { type: 'add'; url: string; username: string; password: string }
  | { type: 'update'; id: string; url: string; username: string; password?: string; note?: string }
  | { type: 'delete'; id: string }
  | { type: 'deletePasskey'; id: string }
  | { type: 'sources' }
  | { type: 'importBrowser'; source: string; profile: string }
  | { type: 'importFile' }
  | { type: 'export' }
  | { type: 'openPrivacySettings' }

export interface VaultReplies {
  list: { logins: LoginSummary[]; passkeys: PasskeySummary[] }
  reveal: { password: string } | { error: string }
  add: { error?: string }
  update: { error?: string }
  delete: { error?: string }
  deletePasskey: { error?: string }
  sources: ImportSource[]
  importBrowser: ImportResult | { error: string }
  /** null: you closed the file dialog. */
  importFile: ImportResult | { error: string } | null
  export: { saved: string | null; error?: string }
  openPrivacySettings: Record<string, never>
}

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
  | { type: 'tab.open'; input: string; where: 'new' | 'current' | 'split' }
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
  | { type: 'space.create'; name: string; icon: string; theme: SpaceTheme; profile?: ProfileChoice }
  | { type: 'space.setProfile'; spaceId: string; profile: ProfileChoice }
  | { type: 'item.drop'; item: { kind: 'tab' | 'folder'; id: string }; target: DropTarget }
  | { type: 'folder.create'; spaceId: string; parentId: string | null; tabIds?: string[] }
  | { type: 'folder.update'; folderId: string; patch: { name?: string; collapsed?: boolean } }
  | { type: 'folder.contextMenu'; folderId: string }
  /** Group a space's normal tabs into folders (Apple Intelligence where available). */
  | { type: 'space.tidy'; spaceId: string }
  /** Tabs you haven't opened lately: close them (one ⇧⌘T brings them back), set them aside in a folder, or not now. */
  | { type: 'tabs.closeStale'; spaceId: string; tabIds: string[] }
  | { type: 'tabs.folderStale'; spaceId: string; tabIds: string[] }
  | { type: 'space.dismissStale'; spaceId: string }
  | { type: 'space.untidy'; token: number }
  | {
      type: 'space.update'
      spaceId: string
      patch: Partial<Pick<Space, 'name' | 'icon' | 'theme' | 'collapsedPins'>>
    }
  | { type: 'space.contextMenu'; spaceId: string; anchor: Rect }
  | { type: 'space.clearTabs'; spaceId: string }
  | { type: 'ui.setSidebarWidth'; width: number }
  | { type: 'ui.openPalette'; mode: 'new' | 'current' | 'split' }
  | { type: 'ui.closePalette'; refocus: boolean }
  | { type: 'ui.overlayMode'; mode: OverlayMode }
  | { type: 'ui.openPopover'; popover: PopoverSpec }
  | { type: 'ui.copyUrl'; markdown?: boolean }
  | { type: 'ui.toggleCompact' }
  | { type: 'ui.siteInfo'; anchor: Rect }
  | { type: 'site.exportCertificate'; index: number }
  | { type: 'clipboard.write'; text: string }
  | { type: 'media.toggle'; tabId: string }
  | { type: 'media.seek'; tabId: string; seconds: number }
  | { type: 'site.setAdblock'; domain: string; enabled: boolean }
  | { type: 'widevine.respond'; host: string; choice: 'install' | 'later' | 'never' }
  | { type: 'app.relaunch' }
  | { type: 'app.makeDefaultBrowser' }
  /** Screen captures: take one (window coordinates for a region or element), cancel, and act on the result. */
  | { type: 'capture.take'; mode: 'visible' | 'full' | 'area'; rect?: Rect }
  | { type: 'capture.cancel' }
  | { type: 'capture.save' }
  | { type: 'capture.reveal' }
  | { type: 'capture.retake' }
  | { type: 'capture.drag' }
  | { type: 'capture.dismiss' }
  | { type: 'autofill.choose'; index: number }
  | { type: 'autofill.save'; choice: 'save' | 'later' | 'never' }
  | { type: 'autofill.dismiss' }
  | { type: 'autofill.resize'; height: number }
  | { type: 'autofill.manage' }
  | { type: 'autofill.passkeyCreate' }
  | { type: 'autofill.passkeyChoose'; id: string }
  | { type: 'autofill.passkeyOther' }
  /** Translate the page into your language, or back to the original. */
  | { type: 'page.translate'; tabId: string }
  | { type: 'app.openTranslationSettings' }
  /** Summarise the current page, or answer a question about it (with earlier questions and answers). */
  | { type: 'ui.openAssistant'; anchor?: Rect }
  | { type: 'assistant.run'; requestId: string; question?: string; history?: [string, string][] }
  /** Settings › Privacy › Clear browsing data. `since` (ms since epoch) applies to history. */
  /** One protection on or off for one site (from the lock icon). */
  | { type: 'site.setProtection'; domain: string; key: Protection; enabled: boolean }
  | { type: 'site.resetProtections'; domain: string }
  | { type: 'data.clear'; since: number; history: boolean; cookies: boolean; cache: boolean; downloads: boolean }
  | { type: 'window.open'; kind: 'blank' | 'private' }
  /** Compact-mode peek: the card has slid in (show the traffic lights) or started leaving (hide them). */
  | { type: 'ui.peekLights'; visible: boolean }
  | { type: 'dialog.respond'; id: number; ok: boolean; value: string; suppress: boolean }
  | { type: 'auth.respond'; id: number; username: string | null; password: string }
  | { type: 'media.dismiss'; tabId: string }
  | { type: 'media.pauseOthers'; keepTabId: string }
  | { type: 'site.setPermission'; origin: string; permission: string; state: PermissionState }
  | { type: 'site.clearData'; origin: string }
  | { type: 'site.clearDomain'; domain: string }
  | { type: 'permission.respond'; id: number; allow: boolean }
  | { type: 'page.zoom'; direction: 1 | -1 | 0 }
  | { type: 'find.query'; text: string; forward: boolean; findNext: boolean }
  | { type: 'find.stop' }
  | { type: 'download.show'; path: string }
  | { type: 'download.action'; id: string; action: 'open' | 'reveal' | 'pause' | 'resume' | 'cancel' | 'remove' }
  | { type: 'downloads.clear' }
  | { type: 'settings.chooseDownloadFolder' }
  | { type: 'ui.downloads' }
  | { type: 'ui.openHistory' }
  | { type: 'ui.openAbout' }
  | { type: 'extension.setEnabled'; id: string; enabled: boolean }
  | { type: 'extension.remove'; id: string }
  | { type: 'extension.options'; id: string }
  | { type: 'history.remove'; url: string }
  /** Forget history since a time; 0 clears it all. */
  | { type: 'history.clear'; since: number }
  | { type: 'settings.update'; patch: Partial<Settings> }
  | { type: 'ui.openSettings'; section?: string }
  | { type: 'ui.peekSidebar'; show: boolean }
  | { type: 'ui.dismissOverlay' }
  | { type: 'ui.createSpace' }
  | { type: 'pip.back' }
  | { type: 'pip.close' }
  | { type: 'split.add'; tabId: string }
  | { type: 'split.remove'; tabId: string }
  | { type: 'split.dissolve'; splitId: string }
  | { type: 'split.layout'; splitId: string; layout: SplitLayout }
  | { type: 'split.resize'; splitId: string; sizes: number[] }

/** Events pushed from the main process to renderers. */
export type UiEvent =
  | { type: 'palette.open'; mode: 'new' | 'current' | 'split'; currentUrl: string | null }
  /** Capture mode (⇧⌘2): the page's area and its elements (window coordinates) for hover snapping. */
  | { type: 'capture.start'; page: Rect; targets: Rect[]; scrolls: boolean }
  /** A capture is done: a thumbnail, its size, and where it was saved (if it was). */
  | { type: 'capture.result'; thumbnail: string; width: number; height: number; saved: string | null }
  | { type: 'autofill.show'; state: AutofillState; dark: boolean }
  /** Arrow keys and Return pressed in the page's sign-in field while the dropdown is open. */
  | { type: 'autofill.key'; key: 'ArrowDown' | 'ArrowUp' | 'Enter' }
  /** A summary or answer about the page, as it streams in. */
  | { type: 'assistant.text'; requestId: string; text: string; done: boolean; error?: string }
  | { type: 'toast'; toast: ToastSpec }
  | { type: 'history.open' }
  | { type: 'folder.startRename'; folderId: string }
  | { type: 'about.open'; info: AboutInfo }
  /** Show the downloads window (centred, like History). */
  | { type: 'downloads.open' }
  | { type: 'space.startRename'; spaceId: string }
  | { type: 'space.startCreate' }
  | { type: 'popover.open'; popover: PopoverSpec }
  | { type: 'find.open' }
  | { type: 'find.result'; result: FindResult }
  | { type: 'settings.open'; section?: string }
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
  /** History page entries, newest first. */
  history(query: string): Promise<HistoryEntry[]>
  /** History pages that match what a query means (on-device), best first. */
  historyMeaning(query: string): Promise<HistoryEntry[]>
  /** Installed extensions (enabled and disabled). */
  extensions(): Promise<ExtensionInfo[]>
  /** Zepper's password manager, for Settings › Passwords. */
  vault<T extends VaultRequest>(request: T): Promise<VaultReplies[T['type']]>
}

/** An installed extension, for Settings → Extensions. */
export interface ExtensionInfo {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  /** Has a settings page (manifest options_ui / options_page). */
  hasOptions: boolean
}

/** What the About page shows. */
export interface AboutInfo {
  version: string
  chromium: string
  electron: string
  node: string
  v8: string
  widevine: WidevineStatus
  /** When the ad-block filter lists were last downloaded (0 if never). */
  filtersUpdatedAt: number
}

export interface HistoryEntry {
  url: string
  title: string
  visits: number
  lastVisit: number
}

export const IPC = {
  swipe: 'zepper:swipe',
  pipBack: 'zepper:pip-back',
  snapshot: 'zepper:snapshot',
  getSnapshot: 'zepper:get-snapshot',
  event: 'zepper:event',
  command: 'zepper:command',
  suggest: 'zepper:suggest',
  extensions: 'zepper:extensions',
  history: 'zepper:history',
  historyMeaning: 'zepper:history-meaning',
  vault: 'zepper:vault'
} as const
