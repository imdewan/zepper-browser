import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Open tabs from other browsers, so moving to Zepper keeps what you had open:
 * - Chrome and other Chromium browsers: the session file they keep for restoring windows;
 * - Arc: its sidebar (spaces, pinned tabs and folders, favourites, and today's tabs);
 * - Firefox: its session store.
 */

export interface ImportedTab {
  url: string
  title: string
}

export interface ImportedFolder {
  title: string
  items: ImportedItem[]
}

export type ImportedItem = ImportedTab | ImportedFolder

/** A window (Chrome, Firefox) or a space (Arc). */
export interface ImportedGroup {
  /** An Arc space's name and icon (windows have neither). */
  name: string | null
  icon: string | null
  pinned: ImportedItem[]
  tabs: ImportedTab[]
}

export interface ImportedSession {
  groups: ImportedGroup[]
  /** Arc's favourites: Zepper's Essentials. */
  essentials: ImportedTab[]
}

export const isFolder = (item: ImportedItem): item is ImportedFolder => 'items' in item

/** Pages worth bringing over (not new-tab pages, settings or extension pages). */
const usable = (url: unknown): url is string => typeof url === 'string' && /^(https?|file):/i.test(url)

// ---- Chromium -------------------------------------------------------------------------

/** Reads Chromium's Pickle encoding: 4-byte-aligned ints, strings and UTF-16 strings after a size header. */
function pickle(payload: Buffer): { int: () => number; string: () => string; string16: () => string } {
  let pos = 4
  const align = (n: number): number => (n + 3) & ~3
  return {
    int: () => {
      const value = payload.readInt32LE(pos)
      pos += 4
      return value
    },
    string: () => {
      const length = payload.readInt32LE(pos)
      const value = payload.toString('utf8', pos + 4, pos + 4 + length)
      pos += 4 + align(length)
      return value
    },
    string16: () => {
      const length = payload.readInt32LE(pos)
      const value = payload.toString('utf16le', pos + 4, pos + 4 + length * 2)
      pos += 4 + align(length * 2)
      return value
    }
  }
}

/**
 * Chromium's session file (SNSS): a log of commands that rebuild the windows and tabs. The ones that
 * matter here: which window a tab is in and where, its navigation entries and which is current,
 * whether it's pinned, and what was closed.
 */
export function parseChromiumSession(buffer: Buffer): ImportedGroup[] {
  if (buffer.toString('latin1', 0, 4) !== 'SNSS') throw new Error('Not a Chromium session file')
  interface TabState {
    window: number
    index: number
    pinned: boolean
    selected: number
    entries: Map<number, ImportedTab>
  }
  const tabs = new Map<number, TabState>()
  const windowTypes = new Map<number, number>()
  const closedTabs = new Set<number>()
  const closedWindows = new Set<number>()
  const tab = (id: number): TabState => {
    let state = tabs.get(id)
    if (!state) tabs.set(id, (state = { window: -1, index: 0, pinned: false, selected: -1, entries: new Map() }))
    return state
  }
  let pos = 8
  while (pos + 2 <= buffer.length) {
    const size = buffer.readUInt16LE(pos)
    pos += 2
    if (size === 0 || pos + size > buffer.length) break
    const id = buffer[pos]
    const payload = buffer.subarray(pos + 1, pos + size)
    pos += size
    try {
      switch (id) {
        case 0: // SetTabWindow: window, tab
          tab(payload.readInt32LE(4)).window = payload.readInt32LE(0)
          break
        case 2: // SetTabIndexInWindow: tab, index
          tab(payload.readInt32LE(0)).index = payload.readInt32LE(4)
          break
        case 3: // TabClosed (old)
        case 16: // TabClosed
          closedTabs.add(payload.readInt32LE(0))
          break
        case 4: // WindowClosed (old)
        case 17: // WindowClosed
          closedWindows.add(payload.readInt32LE(0))
          break
        case 6: {
          // UpdateTabNavigation: tab, index, url, title, …
          const read = pickle(payload)
          const tabId = read.int()
          const index = read.int()
          const url = read.string()
          const title = read.string16()
          tab(tabId).entries.set(index, { url, title })
          break
        }
        case 7: // SetSelectedNavigationIndex: tab, index
          tab(payload.readInt32LE(0)).selected = payload.readInt32LE(4)
          break
        case 9: // SetWindowType: window, type (0: a normal window)
          windowTypes.set(payload.readInt32LE(0), payload.readInt32LE(4))
          break
        case 12: // SetPinnedState: tab, pinned
          tab(payload.readInt32LE(0)).pinned = payload[4] !== 0
          break
      }
    } catch {
      // A command too short to read: skip it.
    }
  }
  const windows = new Map<number, { index: number; pinned: boolean; page: ImportedTab }[]>()
  for (const [id, state] of tabs) {
    if (closedTabs.has(id) || state.window < 0 || closedWindows.has(state.window)) continue
    if ((windowTypes.get(state.window) ?? 0) !== 0) continue
    const indexes = [...state.entries.keys()]
    if (indexes.length === 0) continue
    const page = state.entries.get(state.selected) ?? state.entries.get(Math.max(...indexes))
    if (!page || !usable(page.url)) continue
    const list = windows.get(state.window) ?? []
    list.push({ index: state.index, pinned: state.pinned, page })
    windows.set(state.window, list)
  }
  return [...windows.values()].map((list) => {
    list.sort((a, b) => a.index - b.index)
    return {
      name: null,
      icon: null,
      pinned: list.filter((t) => t.pinned).map((t) => t.page),
      tabs: list.filter((t) => !t.pinned).map((t) => t.page)
    }
  })
}

/** The newest session file in a Chromium profile (Sessions/Session_…, or the older "Current Session"). */
function chromiumSessionFile(profileDir: string): string | null {
  const sessions = join(profileDir, 'Sessions')
  if (existsSync(sessions)) {
    const newest = readdirSync(sessions)
      .filter((name) => name.startsWith('Session_'))
      .map((name) => join(sessions, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
    if (newest) return newest
  }
  const old = join(profileDir, 'Current Session')
  return existsSync(old) ? old : null
}

// ---- Arc ------------------------------------------------------------------------------

/** Arc stores maps as [id, object, id, object, …]; this gives the objects. */
function objects(list: unknown): Record<string, unknown>[] {
  if (Array.isArray(list)) return list.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v))
  if (list && typeof list === 'object') return Object.values(list).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
  return []
}

interface ArcItem {
  id?: string
  title?: string | null
  childrenIds?: string[]
  data?: { tab?: { savedURL?: string; savedTitle?: string }; list?: unknown }
}

/** Arc's sidebar file: spaces with their pinned tabs (and folders) and today's tabs, plus the favourites. */
export function parseArcSidebar(json: unknown): ImportedSession {
  const containers = objects((json as { sidebar?: { containers?: unknown } })?.sidebar?.containers)
  const main = containers.find((c) => c.spaces && c.items)
  if (!main) throw new Error('This isn’t an Arc sidebar file')
  const items = new Map<string, ArcItem>()
  for (const item of objects(main.items) as ArcItem[]) if (item.id) items.set(item.id, item)

  const build = (id: string): ImportedItem[] => {
    const item = items.get(id)
    if (!item) return []
    const tab = item.data?.tab
    if (tab) return usable(tab.savedURL) ? [{ url: tab.savedURL, title: item.title || tab.savedTitle || tab.savedURL }] : []
    const children = (item.childrenIds ?? []).flatMap(build)
    // A folder keeps its name; anything else holding tabs (a split view) just contributes them.
    return item.data && 'list' in item.data ? [{ title: item.title || 'Folder', items: children }] : children
  }
  const childrenOf = (containerId: string | undefined): ImportedItem[] =>
    containerId ? (items.get(containerId)?.childrenIds ?? []).flatMap(build) : []
  const flatten = (list: ImportedItem[]): ImportedTab[] => list.flatMap((item) => (isFolder(item) ? flatten(item.items) : [item]))

  const groups: ImportedGroup[] = objects(main.spaces).map((space) => {
    const ids = Array.isArray(space.containerIDs) ? (space.containerIDs as unknown[]) : []
    const after = (key: string): string | undefined => {
      const at = ids.indexOf(key)
      return at >= 0 && typeof ids[at + 1] === 'string' ? (ids[at + 1] as string) : undefined
    }
    const iconType = (space.customInfo as { iconType?: { emoji_v2?: string; emoji?: number } } | undefined)?.iconType
    const icon = iconType?.emoji_v2 || (typeof iconType?.emoji === 'number' ? String.fromCodePoint(iconType.emoji) : null)
    return {
      name: typeof space.title === 'string' && space.title ? space.title : 'Space',
      icon,
      pinned: childrenOf(after('pinned')),
      tabs: flatten(childrenOf(after('unpinned')))
    }
  })
  const favourites = (Array.isArray(main.topAppsContainerIDs) ? main.topAppsContainerIDs : []).filter(
    (id): id is string => typeof id === 'string'
  )
  const seen = new Set<string>()
  const essentials = favourites.flatMap((id) => flatten(childrenOf(id))).filter((tab) => !seen.has(tab.url) && !!seen.add(tab.url))
  return { groups, essentials }
}

const ARC_SIDEBAR = (): string => join(homedir(), 'Library', 'Application Support', 'Arc', 'StorableSidebar.json')

// ---- Firefox --------------------------------------------------------------------------

/** Firefox's session files are LZ4 blocks with a "mozLz40" header. */
export function decodeMozLz4(buffer: Buffer): string {
  if (buffer.toString('latin1', 0, 8) !== 'mozLz40\0') throw new Error('Not a Firefox session file')
  const out = Buffer.alloc(buffer.readUInt32LE(8))
  const src = buffer.subarray(12)
  let i = 0
  let o = 0
  while (i < src.length) {
    const token = src[i++]
    let literals = token >> 4
    if (literals === 15) {
      let byte: number
      do literals += byte = src[i++]
      while (byte === 255)
    }
    src.copy(out, o, i, i + literals)
    i += literals
    o += literals
    if (i >= src.length) break
    const offset = src[i] | (src[i + 1] << 8)
    i += 2
    let length = token & 15
    if (length === 15) {
      let byte: number
      do length += byte = src[i++]
      while (byte === 255)
    }
    length += 4
    // Matches may overlap what they copy, so byte by byte.
    for (let k = 0; k < length; k++) out[o + k] = out[o - offset + k]
    o += length
  }
  return out.toString('utf8', 0, o)
}

interface FirefoxSession {
  windows?: { tabs?: { entries?: { url?: string; title?: string }[]; index?: number; pinned?: boolean }[] }[]
}

export function parseFirefoxSession(session: FirefoxSession): ImportedGroup[] {
  return (session.windows ?? [])
    .map((window) => {
      const open = (window.tabs ?? []).flatMap((tab) => {
        const entry = tab.entries?.[(tab.index ?? tab.entries.length) - 1]
        return entry && usable(entry.url) ? [{ pinned: !!tab.pinned, page: { url: entry.url, title: entry.title || entry.url } }] : []
      })
      return {
        name: null,
        icon: null,
        pinned: open.filter((t) => t.pinned).map((t) => t.page),
        tabs: open.filter((t) => !t.pinned).map((t) => t.page)
      }
    })
    .filter((group) => group.pinned.length + group.tabs.length > 0)
}

/** Firefox's live session (while it runs) or the one it saved when it quit, whichever is newer. */
function firefoxSessionFile(profileDir: string): string | null {
  const found = [join(profileDir, 'sessionstore-backups', 'recovery.jsonlz4'), join(profileDir, 'sessionstore.jsonlz4')].filter(existsSync)
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null
}

// ---- Entry point ----------------------------------------------------------------------

/** Reads a file through a copy (the browser may be writing it right now). */
function readCopy(path: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'zepper-tabs-'))
  try {
    const copy = join(dir, 'session')
    copyFileSync(path, copy)
    return readFileSync(copy)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Arc has a sidebar file to import tabs from. */
export const hasArcSidebar = (): boolean => existsSync(ARC_SIDEBAR())

/**
 * Open tabs from a browser. `profileDir` is the profile folder (Chromium, Firefox); Arc's spaces
 * come from its sidebar file instead of a profile.
 */
export function importTabs(kind: 'chromium' | 'arc' | 'firefox', profileDir: string): ImportedSession {
  if (kind === 'arc' && hasArcSidebar()) return parseArcSidebar(JSON.parse(readCopy(ARC_SIDEBAR()).toString('utf8')))
  if (kind === 'firefox') {
    const file = firefoxSessionFile(profileDir)
    if (!file) throw new Error('Firefox has no saved session to import')
    return { groups: parseFirefoxSession(JSON.parse(decodeMozLz4(readCopy(file))) as FirefoxSession), essentials: [] }
  }
  const file = chromiumSessionFile(profileDir)
  if (!file) throw new Error('No open tabs found to import')
  return { groups: parseChromiumSession(readCopy(file)), essentials: [] }
}
