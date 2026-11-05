/// <reference types="node" />
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { PersistedState } from '../src/main/browser'
import { mergeNewestWindow, newestWindowId } from '../src/main/window-restore'
import type { Space } from '../src/shared/types'

const space = (id: string, name: string, profile = 'default'): Space =>
  ({ id, name, icon: '😀', theme: {}, collapsedPins: false, lastTabId: null, pinnedItems: [], profile }) as unknown as Space

const tab = (id: string, kind: 'normal' | 'pinned' | 'essential', spaceId: string): PersistedState['tabs'][number] =>
  ({ id, kind, spaceId, url: `https://example.com/${id}`, title: id, favicon: null, pinned: null, lastActiveAt: 0 }) as PersistedState['tabs'][number]

const state = (spaces: Space[], tabs: PersistedState['tabs'], extra: Partial<PersistedState> = {}): PersistedState => ({
  version: 1,
  spaces,
  tabs,
  activeSpaceId: spaces[0].id,
  activeTabId: null,
  sidebarWidth: 260,
  compact: false,
  adblockEnabled: true,
  ...extra
})

const main = (extra: Partial<PersistedState> = {}): PersistedState =>
  state(
    [space('work', 'Work'), space('home', 'Home', 'home-profile')],
    [tab('pin', 'pinned', 'work'), tab('ess', 'essential', 'work'), tab('old', 'normal', 'work')],
    { activeTabId: 'old', closedWithOthersOpen: true, window: { bounds: { x: 1, y: 1, width: 100, height: 100 }, maximized: false }, ...extra }
  )

test('the closed window keeps its pins, Essentials and spaces, but not its open tabs', () => {
  const merged = mergeNewestWindow(main(), state([space('w2', 'Work')], [tab('new', 'normal', 'w2')]))
  assert.deepEqual(merged.tabs.map((t) => t.id), ['pin', 'ess', 'new'])
  assert.deepEqual(merged.spaces.map((s) => s.id), ['work', 'home'])
})

test("the newest window's open tabs come across, in the matching space, with their history", () => {
  const history = { index: 0, entries: [{ url: 'https://example.com/a', title: 'a' }] } as unknown as PersistedState['tabs'][number]['history']
  const merged = mergeNewestWindow(
    main(),
    state([space('w2', 'Work'), space('h2', 'Home', 'home-profile')], [{ ...tab('a', 'normal', 'w2'), history }, tab('b', 'normal', 'h2')])
  )
  assert.equal(merged.tabs.find((t) => t.id === 'a')?.spaceId, 'work')
  assert.deepEqual(merged.tabs.find((t) => t.id === 'a')?.history, history)
  assert.equal(merged.tabs.find((t) => t.id === 'b')?.spaceId, 'home')
})

test("the newest window's pinned tabs come back as open tabs, and its copies of Essentials don't", () => {
  const pinned = { ...tab('p2', 'pinned', 'w2'), pinned: { url: 'https://example.com/start', title: 'start', favicon: null } }
  const merged = mergeNewestWindow(main(), state([space('w2', 'Work')], [pinned, tab('e2', 'essential', 'w2')]))
  assert.deepEqual(merged.tabs.map((t) => t.id), ['pin', 'ess', 'p2'])
  const carried = merged.tabs.find((t) => t.id === 'p2')
  assert.equal(carried?.kind, 'normal')
  assert.equal(carried?.pinned, null)
  assert.equal(carried?.spaceId, 'work')
  assert.equal(merged.spaces[0].pinnedItems.includes('p2'), false)
})

test('a tab from a space the main window lacks goes where its sign-ins are, or the active space', () => {
  const merged = mergeNewestWindow(
    main({ activeSpaceId: 'home' }),
    state([space('r', 'Renamed', 'home-profile'), space('n', 'New', 'other-profile')], [tab('a', 'normal', 'r'), tab('b', 'normal', 'n')])
  )
  assert.equal(merged.tabs.find((t) => t.id === 'a')?.spaceId, 'home')
  assert.equal(merged.tabs.find((t) => t.id === 'b')?.spaceId, 'home')
})

test('it opens where the newest window was, on what it was showing', () => {
  const bounds = { x: 50, y: 60, width: 700, height: 500 }
  const merged = mergeNewestWindow(
    main(),
    state([space('w2', 'Work'), space('h2', 'Home', 'home-profile')], [tab('a', 'normal', 'h2')], {
      activeSpaceId: 'h2',
      activeTabId: 'a',
      sidebarWidth: 300,
      compact: true,
      window: { bounds, maximized: true }
    })
  )
  assert.equal(merged.activeSpaceId, 'home')
  assert.equal(merged.activeTabId, 'a')
  assert.equal(merged.sidebarWidth, 300)
  assert.equal(merged.compact, true)
  assert.deepEqual(merged.window, { bounds, maximized: true })
})

test("an active tab that doesn't come across isn't left selected", () => {
  const merged = mergeNewestWindow(main(), state([space('w2', 'Work')], [tab('e2', 'essential', 'w2')], { activeTabId: 'e2' }))
  assert.equal(merged.activeTabId, null)
})

test("the newest window's splits come across only whole, and the closed mark goes", () => {
  const split = (id: string, tabIds: string[]): NonNullable<PersistedState['splits']>[number] =>
    ({ id, tabIds, layout: 'horizontal', sizes: [0.5, 0.5] }) as NonNullable<PersistedState['splits']>[number]
  const merged = mergeNewestWindow(
    main(),
    state([space('w2', 'Work')], [tab('a', 'normal', 'w2'), tab('b', 'normal', 'w2'), tab('e', 'essential', 'w2')], {
      splits: [split('whole', ['a', 'b']), split('part', ['a', 'e'])]
    })
  )
  assert.deepEqual(merged.splits?.map((s) => s.id), ['whole'])
  assert.equal('closedWithOthersOpen' in merged, false)
})

test('a tab id already kept is not added twice', () => {
  const merged = mergeNewestWindow(main(), state([space('w2', 'Work')], [tab('pin', 'normal', 'w2')]))
  assert.equal(merged.tabs.filter((t) => t.id === 'pin').length, 1)
})

test('the newest window is the saved file written to last', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zepper-windows-'))
  try {
    assert.equal(newestWindowId(join(dir, 'missing')), null)
    assert.equal(newestWindowId(dir), null)
    const older = '11111111-1111-1111-1111-111111111111'
    const newer = '22222222-2222-2222-2222-222222222222'
    writeFileSync(join(dir, `${newer}.json`), '{}')
    writeFileSync(join(dir, `${older}.json`), '{}')
    writeFileSync(join(dir, 'not-a-window.json'), '{}')
    utimesSync(join(dir, `${older}.json`), new Date(1000), new Date(1000))
    utimesSync(join(dir, `${newer}.json`), new Date(2000), new Date(2000))
    utimesSync(join(dir, 'not-a-window.json'), new Date(3000), new Date(3000))
    assert.equal(newestWindowId(dir), newer)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
