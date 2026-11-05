import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PersistedState } from './browser'

/** A saved window's file in the profile's windows folder. */
export const WINDOW_FILE = /^[0-9a-f-]{36}\.json$/

/** The saved window written to last (its id), or null when there's none. */
export function newestWindowId(dir: string): string | null {
  let files: string[]
  try {
    files = readdirSync(dir).filter((file) => WINDOW_FILE.test(file))
  } catch {
    return null
  }
  const written = (file: string): number => statSync(join(dir, file)).mtimeMs
  const newest = files.sort((a, b) => written(b) - written(a))[0]
  return newest ? newest.slice(0, -'.json'.length) : null
}

/**
 * The main window's state once you've closed it and carried on in another window: that window's tabs
 * and place on screen, in the main window's spaces. Its pinned tabs come back as open tabs, since pins
 * belong to the main window. The main window's own open tabs went when you closed it. Its spaces, pinned
 * tabs and Essentials stay, as it's the window that keeps and syncs them.
 */
export function mergeNewestWindow(main: PersistedState, newest: PersistedState): PersistedState {
  const active = main.spaces.find((space) => space.id === main.activeSpaceId) ?? main.spaces[0]
  /** The main window's space for one of the other window's: its counterpart, or else one with the same sign-ins. */
  const spaceFor = (id: string | null | undefined): string => {
    const from = newest.spaces.find((space) => space.id === id)
    const match =
      main.spaces.find((space) => space.name === from?.name && space.profile === from?.profile) ??
      main.spaces.find((space) => space.profile === from?.profile)
    return (match ?? active).id
  }
  const kept = main.tabs.filter((tab) => tab.kind !== 'normal')
  const keptIds = new Set(kept.map((tab) => tab.id))
  const carried = newest.tabs
    .filter((tab) => tab.kind !== 'essential' && !keptIds.has(tab.id))
    .map((tab) => ({ ...tab, kind: 'normal' as const, pinned: null, spaceId: spaceFor(tab.spaceId) }))
  const carriedIds = new Set(carried.map((tab) => tab.id))
  const { closedWithOthersOpen: _closed, ...state } = main
  return {
    ...state,
    tabs: [...kept, ...carried],
    splits: [...(main.splits ?? []), ...(newest.splits ?? []).filter((split) => split.tabIds.every((id) => carriedIds.has(id)))],
    activeSpaceId: spaceFor(newest.activeSpaceId),
    activeTabId: newest.activeTabId && carriedIds.has(newest.activeTabId) ? newest.activeTabId : null,
    sidebarWidth: newest.sidebarWidth,
    compact: newest.compact,
    window: newest.window
  }
}
