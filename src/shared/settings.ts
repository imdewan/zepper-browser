export type PinnedCloseBehavior = 'reset-unload-switch' | 'unload-switch' | 'reset-switch' | 'switch' | 'reset' | 'close'

export type SearchEngineId = 'google' | 'duckduckgo' | 'bing' | 'brave' | 'kagi' | 'ecosia' | 'perplexity'

export interface Settings {
  // Appearance
  colorScheme: 'system' | 'light' | 'dark'
  sidebarPosition: 'left' | 'right'
  /** Gap around the web content card, in px (Zen's element separation). */
  contentGap: number
  /** Corner radius of the web content card, in px. */
  cornerRadius: number
  density: 'comfortable' | 'compact'
  essentialsGlow: boolean
  reduceMotion: boolean
  appIcon: 'auto' | 'light' | 'dark'
  /** How much of the desktop shows through the window: 0 = solid, 1 = full vibrancy. */
  windowTransparency: number
  // Tabs
  newTabPosition: 'top' | 'bottom'
  pinnedCloseBehavior: PinnedCloseBehavior
  closeSelectsRecent: boolean
  autoPictureInPicture: boolean
  // Search
  searchEngine: SearchEngineId
  searchSuggestions: boolean
  // Spaces and gestures
  swipeBetweenSpaces: boolean
  swipeToNavigate: boolean
  wrapSpaces: boolean
  compactRevealOnHover: boolean
  // Privacy
  adblock: boolean
  globalPrivacyControl: boolean
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
  windowTransparency: 1,
  newTabPosition: 'top',
  pinnedCloseBehavior: 'reset-unload-switch',
  closeSelectsRecent: true,
  autoPictureInPicture: true,
  searchEngine: 'google',
  searchSuggestions: true,
  swipeBetweenSpaces: true,
  swipeToNavigate: true,
  wrapSpaces: true,
  compactRevealOnHover: true,
  adblock: true,
  globalPrivacyControl: true
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
