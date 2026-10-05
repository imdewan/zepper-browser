import { DEFAULT_SETTINGS } from '@shared/settings'
import type { Command, HistoryEntry, Snapshot, Space, Suggestion, Tab, UiEvent, ZepperApi } from '@shared/types'

/**
 * The preload exposes `window.zepper` inside Electron. When the renderer is
 * opened in a plain browser (UI development), fall back to an in-memory mock
 * with sample spaces and tabs so the interface can be exercised directly.
 */
export const zepper: ZepperApi = window.zepper ?? createMock()

function favicon(host: string): string {
  return `https://www.google.com/s2/favicons?domain=${host}&sz=64`
}

function createMock(): ZepperApi {
  // Stand-in for macOS vibrancy so the translucent chrome is visible in a normal browser.
  document.documentElement.dataset.mock = 'true'
  const now = Date.now()
  const tab = (fields: Partial<Tab> & Pick<Tab, 'id' | 'kind' | 'url' | 'title'>): Tab => ({
    spaceId: null,
    favicon: favicon(new URL(fields.url).hostname),
    pinned: null,
    loaded: true,
    loading: false,
    audible: false,
    muted: false,
    canGoBack: true,
    canGoForward: false,
    lastActiveAt: now,
    blockedCount: 12,
    media: null,
    audibleAt: 0,
    ...fields
  })
  const spaces: Space[] = [
    {
      id: 's1',
      name: 'Personal',
      icon: '😀',
      theme: { colors: [], opacity: 0.5, texture: 0 },
      collapsedPins: false,
      lastTabId: 'e1',
      profile: 'default',
      pinnedItems: ['p1', 'p2', 'p3']
    },
    {
      id: 's2',
      name: 'Work',
      icon: '💼',
      theme: { colors: ['#7b6cf6', '#c06cf6', '#f66cb4'], opacity: 0.6, texture: 0.15 },
      collapsedPins: false,
      lastTabId: null,
      profile: crypto.randomUUID(),
      pinnedItems: ['w1']
    },
    {
      id: 's3',
      name: 'Reading',
      icon: '📚',
      theme: { colors: ['#e07a2d', '#f2b134'], opacity: 0.55, texture: 0 },
      collapsedPins: false,
      lastTabId: null,
      profile: crypto.randomUUID(),
      pinnedItems: []
    }
  ]
  const pin = (url: string, title: string): Tab['pinned'] => ({ url, title, favicon: favicon(new URL(url).hostname) })
  let snapshot: Snapshot = {
    spaces,
    tabs: [
      tab({
        id: 'e1',
        kind: 'essential',
        url: 'https://discord.com/app',
        title: 'Discord',
        pinned: pin('https://discord.com/app', 'Discord')
      }),
      tab({ id: 'e2', kind: 'essential', url: 'https://google.com', title: 'Google', pinned: pin('https://google.com', 'Google') }),
      tab({
        id: 'p1',
        kind: 'pinned',
        spaceId: 's1',
        url: 'https://news.ycombinator.com',
        title: 'Hacker News',
        pinned: pin('https://news.ycombinator.com', 'Hacker News')
      }),
      tab({
        id: 'p2',
        kind: 'pinned',
        spaceId: 's1',
        url: 'https://app.element.io/#/room/build',
        title: 'Element | build',
        pinned: pin('https://app.element.io', 'Element')
      }),
      tab({
        id: 'p3',
        kind: 'pinned',
        spaceId: 's1',
        url: 'https://github.com/electron/electron',
        title: 'electron/electron: Build cross-platform desktop apps',
        loaded: false,
        pinned: pin('https://github.com/electron/electron', 'electron/electron')
      }),
      tab({ id: 'n1', kind: 'normal', spaceId: 's1', url: 'https://www.google.com/search?q=spaces', title: 'Google' }),
      tab({
        id: 'n2',
        kind: 'normal',
        spaceId: 's1',
        url: 'https://www.youtube.com',
        title: 'YouTube',
        audible: true,
        media: { title: 'Lofi beats to browse to', artist: 'Lofi Girl', artwork: null }
      }),
      tab({
        id: 'w1',
        kind: 'pinned',
        spaceId: 's2',
        url: 'https://linear.app',
        title: 'Linear',
        pinned: pin('https://linear.app', 'Linear')
      }),
      tab({ id: 'w2', kind: 'normal', spaceId: 's2', url: 'https://figma.com', title: 'Figma — Zepper sidebar' }),
      tab({ id: 'r1', kind: 'normal', spaceId: 's3', url: 'https://news.ycombinator.com', title: 'Hacker News' })
    ],
    activeSpaceId: 's1',
    activeTabId: 'e1',
    sidebarWidth: 250,
    compact: false,
    focused: true,
    fullscreen: false,
    adblockEnabled: true,
    settings: DEFAULT_SETTINGS,
    kind: 'main',
    widevine: { state: 'off', version: null },
    downloads: [],
    paletteOpen: false,
    folders: [],
    tidy: { kind: 'ai' },
    windowSize: { width: window.innerWidth, height: window.innerHeight },
    splits: [],
    panes: []
  }
  const snapshotListeners = new Set<(s: Snapshot) => void>()
  const eventListeners = new Set<(e: UiEvent) => void>()
  const set = (patch: Partial<Snapshot>): void => {
    snapshot = { ...snapshot, ...patch }
    snapshotListeners.forEach((l) => l(snapshot))
  }
  const updateTab = (id: string, patch: Partial<Tab>): void =>
    set({ tabs: snapshot.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })

  const handle = (command: Command): void => {
    console.info('[mock] command', command)
    switch (command.type) {
      case 'tab.activate': {
        const target = snapshot.tabs.find((t) => t.id === command.tabId)
        updateTab(command.tabId, { loaded: true, lastActiveAt: Date.now() })
        set({ activeTabId: command.tabId, activeSpaceId: target?.spaceId ?? snapshot.activeSpaceId })
        break
      }
      case 'tab.close':
        set({
          tabs: snapshot.tabs.filter((t) => t.id !== command.tabId || t.kind !== 'normal'),
          activeTabId: snapshot.activeTabId === command.tabId ? null : snapshot.activeTabId
        })
        break
      case 'space.switch': {
        const space = snapshot.spaces.find((s) => s.id === command.spaceId)
        set({ activeSpaceId: command.spaceId, activeTabId: space?.lastTabId ?? null })
        break
      }
      case 'space.switchRelative': {
        const i = snapshot.spaces.findIndex((s) => s.id === snapshot.activeSpaceId)
        const next = snapshot.spaces[(i + command.delta + snapshot.spaces.length) % snapshot.spaces.length]
        set({ activeSpaceId: next.id, activeTabId: next.lastTabId })
        break
      }
      case 'space.update':
        set({ spaces: snapshot.spaces.map((s) => (s.id === command.spaceId ? { ...s, ...command.patch } : s)) })
        break
      case 'space.create': {
        const space: Space = {
          id: `s${Date.now()}`,
          name: command.name,
          icon: command.icon,
          theme: command.theme,
          collapsedPins: false,
          lastTabId: null,
          profile: crypto.randomUUID(),
          pinnedItems: []
        }
        set({ spaces: [...snapshot.spaces, space], activeSpaceId: space.id, activeTabId: null })
        break
      }
      case 'ui.setSidebarWidth':
        set({ sidebarWidth: Math.min(500, Math.max(180, command.width)) })
        break
      case 'ui.toggleCompact':
        set({ compact: !snapshot.compact })
        break
      case 'settings.update':
        set({ settings: { ...snapshot.settings, ...command.patch } })
        break
      case 'ui.openSettings':
        eventListeners.forEach((l) => l({ type: 'settings.open' }))
        break
      case 'space.contextMenu':
        eventListeners.forEach((l) => l({ type: 'space.startRename', spaceId: command.spaceId }))
        break
    }
  }

  return {
    platform: 'darwin',
    getSnapshot: async () => snapshot,
    onSnapshot(callback) {
      snapshotListeners.add(callback)
      return () => snapshotListeners.delete(callback)
    },
    onEvent(callback) {
      eventListeners.add(callback)
      return () => eventListeners.delete(callback)
    },
    send: handle,
    async extensions() {
      return []
    },
    async history(): Promise<HistoryEntry[]> {
      const now = Date.now()
      return [
        { url: 'https://news.ycombinator.com/', title: 'Hacker News', visits: 12, lastVisit: now - 5 * 60_000 },
        { url: 'https://github.com/electron/electron', title: 'electron/electron', visits: 3, lastVisit: now - 3 * 3_600_000 },
        { url: 'https://en.wikipedia.org/wiki/Browser', title: 'Web browser - Wikipedia', visits: 1, lastVisit: now - 26 * 3_600_000 }
      ]
    },
    async suggest(text: string): Promise<Suggestion[]> {
      if (!text) return []
      return [
        { kind: 'search', query: text, url: '', fromProvider: false },
        { kind: 'tab', tabId: 'n2', url: 'https://www.youtube.com', title: 'YouTube', favicon: favicon('youtube.com') },
        { kind: 'history', url: 'https://github.com/electron', title: 'Electron · GitHub' },
        { kind: 'search', query: `${text} browser`, url: '', fromProvider: true }
      ]
    }
  }
}
