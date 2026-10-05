export type PinnedCloseBehavior = 'reset-unload-switch' | 'unload-switch' | 'reset-switch' | 'switch' | 'reset' | 'close'

export type UserAgentChoice = 'chrome' | 'edge' | 'firefox' | 'safari' | 'custom'

export const USER_AGENT_LABELS: Record<UserAgentChoice, string> = {
  chrome: 'Chrome (recommended)',
  edge: 'Microsoft Edge',
  firefox: 'Firefox',
  safari: 'Safari',
  custom: 'Custom…'
}

export type PipSize = 'small' | 'medium' | 'large'

/** Share of the screen's width the floating player starts at. */
export const PIP_WIDTH: Record<PipSize, number> = { small: 0.18, medium: 0.25, large: 0.33 }

export type SearchEngineId = 'google' | 'duckduckgo' | 'bing' | 'brave' | 'kagi' | 'ecosia' | 'perplexity'

export type SecureDns = 'off' | 'automatic' | 'cloudflare' | 'quad9' | 'google'

/** DNS-over-HTTPS endpoints for the providers offered in Settings. */
export const SECURE_DNS_SERVERS = {
  cloudflare: 'https://chrome.cloudflare-dns.com/dns-query',
  quad9: 'https://dns.quad9.net/dns-query',
  google: 'https://dns.google/dns-query{?dns}'
} as const

export interface Settings {
  // Appearance
  colorScheme: 'system' | 'light' | 'dark'
  sidebarPosition: 'left' | 'right'
  /** Gap around the web content card, in px. */
  contentGap: number
  /** Corner radius of the web content card, in px. */
  cornerRadius: number
  density: 'comfortable' | 'compact'
  essentialsGlow: boolean
  reduceMotion: boolean
  appIcon: 'auto' | 'light' | 'dark'
  /** How much of the desktop shows through the window: 0 = solid, 1 = full vibrancy. */
  /**
   * How much the desktop shows through the window: 0 is solid, 0.5 (the default) lets the
   * system material show under the space's gradient, and beyond that the gradient fades too.
   */
  transparency: number
  // Tabs
  newTabPosition: 'top' | 'bottom'
  pinnedCloseBehavior: PinnedCloseBehavior
  closeSelectsRecent: boolean
  /** Reopen last session's open (unpinned) tabs when Zepper starts. */
  restoreTabs: boolean
  /** Keep Essentials between launches. */
  keepEssentials: boolean
  /** Show the Tidy button beside Clear. */
  showTidy: boolean
  // Media
  autoPictureInPicture: boolean
  /** Floating player width as a share of the screen. */
  pipSize: PipSize
  showMediaCard: boolean
  /** Google Widevine, for DRM-protected video (Netflix, Crunchyroll…). Off until you opt in, like Brave. */
  widevine: boolean
  /** Ask to turn Widevine on when a site needs it. */
  widevinePrompt: boolean
  /** When a tab starts playing while others already are. */
  otherMedia: 'nothing' | 'offer' | 'pause'
  // Search
  searchEngine: SearchEngineId
  searchSuggestions: boolean
  /** DuckDuckGo bangs (!yt, !gh…) go straight to the site. */
  bangs: boolean
  /** An empty command bar lists recently visited sites. */
  paletteRecents: boolean
  // Windows and downloads
  /** ⌘N opens on the current space or an empty window. */
  newWindowSpace: 'current' | 'empty'
  /** Also hide cookie banners and other annoyances. */
  hideCookieBanners: boolean
  /** Add per-site noise to canvas, WebGL and audio readouts, and limit what hardware details pages see. */
  blockFingerprinting: boolean
  /** Third-party requests don't send or receive cookies. */
  blockCrossSiteCookies: boolean
  /** Load plain-HTTP pages over HTTPS when the site supports it. */
  httpsUpgrade: boolean
  /** Remove click identifiers (fbclid, gclid…) and Google AMP wrappers from links you open. */
  cleanLinks: boolean
  /** DNS over HTTPS: off, automatic (when your DNS provider supports it), or a provider. */
  secureDns: SecureDns
  /** Where downloads are saved ('' means the Downloads folder). */
  downloadPath: string
  /** Ask where to save each download. */
  downloadAsk: boolean
  // Spaces and gestures
  swipeBetweenSpaces: boolean
  swipeToNavigate: boolean
  wrapSpaces: boolean
  compactRevealOnHover: boolean
  // Privacy
  adblock: boolean
  /** Sites (registrable domains, e.g. youtube.com) where ad blocking is turned off. */
  adblockAllowlist: string[]
  globalPrivacyControl: boolean
  /** Forget browsing history when Zepper quits. */
  clearHistoryOnQuit: boolean
  /** Which browser sites think you're using. */
  userAgent: UserAgentChoice
  customUserAgent: string
  // Extensions
  /** Extensions shown beside the extensions button (or in the extensions row); the rest live in its panel. */
  pinnedExtensions: string[]
  /** Pinned extensions get their own row under the address bar. */
  extensionsRow: boolean
  /** Installed extensions you've turned off (unloaded at startup). */
  disabledExtensions: { id: string; name: string; version: string; description: string; path: string; hasOptions: boolean }[]
  /** Make Google's sign-in page accept Zepper (see main/compat.ts). */
  googleSignInCompat: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  colorScheme: 'system',
  sidebarPosition: 'left',
  contentGap: 8,
  cornerRadius: 10,
  density: 'comfortable',
  essentialsGlow: true,
  reduceMotion: false,
  appIcon: 'auto',
  transparency: 0.5,
  newTabPosition: 'top',
  pinnedCloseBehavior: 'reset-unload-switch',
  closeSelectsRecent: true,
  restoreTabs: true,
  keepEssentials: true,
  showTidy: true,
  autoPictureInPicture: true,
  pipSize: 'medium',
  showMediaCard: true,
  widevine: false,
  widevinePrompt: true,
  otherMedia: 'offer',
  searchEngine: 'google',
  searchSuggestions: true,
  bangs: true,
  paletteRecents: true,
  newWindowSpace: 'current',
  secureDns: 'automatic',
  hideCookieBanners: true,
  blockFingerprinting: true,
  blockCrossSiteCookies: true,
  httpsUpgrade: true,
  cleanLinks: true,
  downloadPath: '',
  downloadAsk: false,
  swipeBetweenSpaces: true,
  swipeToNavigate: true,
  wrapSpaces: true,
  compactRevealOnHover: true,
  adblock: true,
  adblockAllowlist: [],
  globalPrivacyControl: true,
  clearHistoryOnQuit: false,
  userAgent: 'chrome',
  customUserAgent: '',
  pinnedExtensions: [],
  extensionsRow: false,
  disabledExtensions: [],
  googleSignInCompat: true
}

export const SEARCH_ENGINES: Record<SearchEngineId, { name: string; search: string; suggest: string | null }> = {
  google: {
    name: 'Google',
    search: 'https://www.google.com/search?q=%s',
    suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s'
  },
  duckduckgo: { name: 'DuckDuckGo', search: 'https://duckduckgo.com/?q=%s', suggest: 'https://duckduckgo.com/ac/?type=list&q=%s' },
  bing: { name: 'Bing', search: 'https://www.bing.com/search?q=%s', suggest: 'https://api.bing.com/osjson.aspx?query=%s' },
  brave: { name: 'Brave Search', search: 'https://search.brave.com/search?q=%s', suggest: 'https://search.brave.com/api/suggest?q=%s' },
  kagi: { name: 'Kagi', search: 'https://kagi.com/search?q=%s', suggest: 'https://kagi.com/api/autosuggest?q=%s' },
  ecosia: { name: 'Ecosia', search: 'https://www.ecosia.org/search?q=%s', suggest: 'https://ac.ecosia.org/autocomplete?type=list&q=%s' },
  perplexity: { name: 'Perplexity', search: 'https://www.perplexity.ai/search?q=%s', suggest: null }
}

export const PINNED_CLOSE_LABELS: Record<PinnedCloseBehavior, string> = {
  'reset-unload-switch': 'Reset URL, unload and switch away',
  'unload-switch': 'Unload and switch away',
  'reset-switch': 'Reset URL and switch away',
  switch: 'Just switch to another tab',
  reset: 'Only reset the URL',
  close: 'Close the tab'
}
