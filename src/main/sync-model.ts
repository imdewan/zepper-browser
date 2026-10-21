import { generateNKeysBetween } from 'fractional-indexing'
import type { FolderRecord, PinRecord, SpaceRecord } from '@shared/sync-protocol'
import type { Folder, Space, SpaceTheme, Tab } from '@shared/types'

/**
 * Zepper Sync's view of a window: its spaces, Essentials, pinned tabs and folders as records, and
 * other devices' changes back into it. The desktop keeps order as arrays (spaces, each space's
 * pinned area and Essentials, each folder's items); sync gives each item a fractional index, so a
 * move on one device changes only what moved. `orders` remembers those indexes between calls.
 */

export type SharedRecord = SpaceRecord | PinRecord | FolderRecord

export interface Synced {
  spaces: Space[]
  tabs: Tab[]
  folders: Folder[]
}

/** Each synced item's fractional index, by id. */
export type Orders = Map<string, string>

export interface Change {
  record: SharedRecord | null
  /** What the server had before (what a deletion deletes). */
  previous: SharedRecord | undefined
}

/**
 * Keys for a list in the order given, keeping the keys of items already in order (the longest run
 * whose keys increase) and giving the others new ones between their neighbours.
 */
export function reorder(ids: readonly string[], current: ReadonlyMap<string, string>): Map<string, string> {
  const keys = ids.map((id) => current.get(id) ?? null)
  const keep = longestIncreasing(keys)
  const result = new Map<string, string>()
  let i = 0
  while (i < ids.length) {
    if (keep.has(i)) {
      result.set(ids[i], keys[i]!)
      i++
      continue
    }
    let j = i
    while (j < ids.length && !keep.has(j)) j++
    const before = i > 0 ? result.get(ids[i - 1])! : null
    const after = j < ids.length ? keys[j] : null
    generateNKeysBetween(before, after, j - i).forEach((key, n) => result.set(ids[i + n], key))
    i = j
  }
  return result
}

function longestIncreasing(keys: (string | null)[]): Set<number> {
  const tails: number[] = []
  const previous = new Array<number>(keys.length).fill(-1)
  keys.forEach((key, i) => {
    if (key === null) return
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (keys[tails[mid]]! < key) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) previous[i] = tails[lo - 1]
    tails[lo] = i
  })
  const keep = new Set<number>()
  for (let i = tails.at(-1) ?? -1; i !== -1; i = previous[i]) keep.add(i)
  return keep
}

function assign(orders: Orders, ids: string[]): void {
  for (const [id, key] of reorder(ids, orders)) orders.set(id, key)
}

function themeRecord(theme: SpaceTheme): SpaceRecord['theme'] {
  const { colors, opacity, texture, scheme } = theme
  return scheme ? { colors: [...colors], opacity, texture, scheme } : { colors: [...colors], opacity, texture }
}

/** The window's shared state as records (giving keys to what's new or has moved). */
export function toRecords(state: Synced, orders: Orders): SharedRecord[] {
  const records: SharedRecord[] = []
  const tabs = new Map(state.tabs.map((t) => [t.id, t]))
  const folders = new Map(state.folders.map((f) => [f.id, f]))
  assign(
    orders,
    state.spaces.map((s) => s.id)
  )
  for (const space of state.spaces) {
    records.push({
      type: 'space',
      id: space.id,
      name: space.name,
      icon: space.icon,
      theme: themeRecord(space.theme),
      order: orders.get(space.id)!
    })
    const essentials = state.tabs.filter((t) => t.kind === 'essential' && t.spaceId === space.id)
    assign(
      orders,
      essentials.map((t) => t.id)
    )
    for (const tab of essentials) records.push(pinRecord(tab, space.id, 'essential', null, orders))
    const walk = (items: string[], parentId: string | null): void => {
      const listed = items.filter((id) => folders.has(id) || tabs.get(id)?.kind === 'pinned')
      assign(orders, listed)
      for (const id of listed) {
        const folder = folders.get(id)
        if (folder) {
          records.push({ type: 'folder', id, spaceId: space.id, parentId, order: orders.get(id)!, name: folder.name })
          walk(folder.items, id)
        } else {
          records.push(pinRecord(tabs.get(id)!, space.id, 'pinned', parentId, orders))
        }
      }
    }
    walk(space.pinnedItems, null)
  }
  return records
}

function pinRecord(tab: Tab, spaceId: string, zone: PinRecord['zone'], parentId: string | null, orders: Orders): PinRecord {
  return {
    type: 'pin',
    id: tab.id,
    spaceId,
    zone,
    parentId,
    order: orders.get(tab.id)!,
    url: tab.pinned?.url ?? tab.url,
    title: tab.pinned?.title || tab.title
  }
}

export interface Makers {
  /** A pinned tab or Essential that came from another device (not loaded until you open it). */
  tab(fields: Partial<Tab> & Pick<Tab, 'id' | 'kind' | 'url'>): Tab
  /** A space from another device (sharing this computer's main sign-ins). */
  space(record: SpaceRecord): Space
}

export interface Applied {
  /** Tabs that went (their pages should close). */
  removed: Tab[]
  /** Spaces that went; their open tabs need a new space. */
  removedSpaces: string[]
}

/** Puts other devices' changes into the window's state, in place. */
export function applyChanges(state: Synced, changes: Change[], orders: Orders, make: Makers): Applied {
  // Everything here has a key first, so what came in can be placed among it.
  toRecords(state, orders)
  const removed: Tab[] = []
  const removedSpaces: string[] = []
  /** Where changed pinned tabs and folders now live (null: the space's top level). */
  const parents = new Map<string, string | null>()

  for (const { record, previous } of changes) {
    if (!record) {
      if (!previous) continue
      if (previous.type === 'space') {
        state.spaces = state.spaces.filter((s) => s.id !== previous.id)
        removedSpaces.push(previous.id)
      } else if (previous.type === 'folder') {
        state.folders = state.folders.filter((f) => f.id !== previous.id)
      } else {
        const tab = state.tabs.find((t) => t.id === previous.id)
        if (tab?.loaded) {
          // Open here: it stays open, as an ordinary tab.
          tab.kind = 'normal'
          tab.pinned = null
        } else if (tab) {
          state.tabs = state.tabs.filter((t) => t !== tab)
          removed.push(tab)
        }
      }
      orders.delete(previous.id)
      continue
    }
    orders.set(record.id, record.order)
    if (record.type === 'space') {
      const space = state.spaces.find((s) => s.id === record.id)
      if (!space) {
        state.spaces.push(make.space(record))
      } else {
        space.name = record.name
        space.icon = record.icon
        // The colour wheel's dots stay while the colours are the same.
        const same = JSON.stringify(space.theme.colors) === JSON.stringify(record.theme.colors)
        space.theme = same ? { ...space.theme, ...record.theme } : { ...record.theme }
      }
    } else if (record.type === 'folder') {
      const folder = state.folders.find((f) => f.id === record.id)
      if (folder) {
        folder.name = record.name
        folder.spaceId = record.spaceId
      } else {
        state.folders.push({ id: record.id, spaceId: record.spaceId, name: record.name, collapsed: false, items: [] })
      }
      parents.set(record.id, record.parentId)
    } else {
      const tab = state.tabs.find((t) => t.id === record.id)
      const pinned = { url: record.url, title: record.title, favicon: tab?.pinned?.favicon ?? tab?.favicon ?? null }
      if (tab) {
        tab.kind = record.zone
        tab.spaceId = record.spaceId
        tab.pinned = pinned
        // Not open here: it opens where it's pinned to now.
        if (!tab.loaded) {
          tab.url = record.url
          tab.title = record.title
        }
      } else {
        state.tabs.push(
          make.tab({ id: record.id, kind: record.zone, spaceId: record.spaceId, url: record.url, title: record.title, pinned })
        )
      }
      if (record.zone === 'pinned') parents.set(record.id, record.parentId)
    }
  }

  relist(state, orders, parents)
  return { removed, removedSpaces }
}

/** Rebuilds the arrays in key order, with changed items in their new places. */
function relist(state: Synced, orders: Orders, parents: Map<string, string | null>): void {
  const key = (id: string): string => orders.get(id) ?? '~'
  const byKey = (a: string, b: string): number => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a < b ? -1 : 1)
  state.spaces.sort((a, b) => byKey(a.id, b.id))

  // Where everything is now: its old place, unless it was moved.
  const parentOf = new Map<string, string | null>()
  for (const space of state.spaces) for (const id of space.pinnedItems) parentOf.set(id, null)
  for (const folder of state.folders) for (const id of folder.items) parentOf.set(id, folder.id)
  for (const [id, parent] of parents) parentOf.set(id, parent)

  const folderIds = new Set(state.folders.map((f) => f.id))
  const members = (spaceId: string, parent: string | null): string[] =>
    [
      ...state.tabs.filter((t) => t.kind === 'pinned' && t.spaceId === spaceId).map((t) => t.id),
      ...state.folders.filter((f) => f.spaceId === spaceId).map((f) => f.id)
    ]
      .filter((id) => {
        const p = parentOf.get(id) ?? null
        // A missing folder means the top level.
        return (p !== null && folderIds.has(p) ? p : null) === parent
      })
      .sort(byKey)
  for (const space of state.spaces) space.pinnedItems = members(space.id, null)
  for (const folder of state.folders) folder.items = members(folder.spaceId, folder.id)

  // Essentials keep their places among the other tabs, in their new order.
  const essentialSlots = state.tabs.map((t, i) => (t.kind === 'essential' ? i : -1)).filter((i) => i >= 0)
  const essentials = essentialSlots.map((i) => state.tabs[i]).sort((a, b) => byKey(a.id, b.id))
  essentialSlots.forEach((slot, n) => (state.tabs[slot] = essentials[n]))
}
