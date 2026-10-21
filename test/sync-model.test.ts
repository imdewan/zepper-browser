/// <reference types="node" />
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyChanges, toRecords, type Makers, type Orders, type SharedRecord, type Synced } from '../src/main/sync-model'
import type { Space, Tab } from '../src/shared/types'

const theme = { colors: ['#2d6cdf'], opacity: 0.6, texture: 0 }

function tab(fields: Partial<Tab> & Pick<Tab, 'id' | 'kind' | 'url'>): Tab {
  return {
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
    lastActiveAt: 0,
    blockedCount: 0,
    media: null,
    audibleAt: 0,
    language: null,
    translation: null,
    reader: false,
    capture: null,
    emoji: null,
    ...fields
  } as Tab
}

function space(id: string, name: string, pinnedItems: string[] = []): Space {
  return { id, name, icon: '💼', theme, collapsedPins: false, lastTabId: null, pinnedItems, profile: 'default' }
}

const make: Makers = {
  tab: (fields) => tab(fields),
  space: (r) => space(r.id, r.name)
}

function desktop(): Synced {
  return {
    spaces: [space('work', 'Work', ['docs', 'hn'])],
    folders: [{ id: 'docs', spaceId: 'work', name: 'Docs', collapsed: false, items: ['mdn'] }],
    tabs: [
      tab({
        id: 'gh',
        kind: 'essential',
        spaceId: 'work',
        url: 'https://github.com/',
        pinned: { url: 'https://github.com/', title: 'GitHub', favicon: null }
      }),
      tab({
        id: 'mdn',
        kind: 'pinned',
        spaceId: 'work',
        url: 'https://developer.mozilla.org/',
        pinned: { url: 'https://developer.mozilla.org/', title: 'MDN', favicon: null }
      }),
      tab({
        id: 'hn',
        kind: 'pinned',
        spaceId: 'work',
        url: 'https://news.ycombinator.com/',
        pinned: { url: 'https://news.ycombinator.com/', title: 'HN', favicon: null }
      }),
      tab({ id: 'open', kind: 'normal', spaceId: 'work', url: 'https://example.com/' })
    ]
  }
}

const byId = (records: SharedRecord[]): Map<string, SharedRecord> => new Map(records.map((r) => [r.id, r]))

test('describes spaces, Essentials, pinned tabs and folders (not open tabs)', () => {
  const orders: Orders = new Map()
  const records = byId(toRecords(desktop(), orders))
  assert.deepEqual([...records.keys()].sort(), ['docs', 'gh', 'hn', 'mdn', 'work'])
  assert.deepEqual(records.get('mdn'), {
    type: 'pin',
    id: 'mdn',
    spaceId: 'work',
    zone: 'pinned',
    parentId: 'docs',
    order: orders.get('mdn'),
    url: 'https://developer.mozilla.org/',
    title: 'MDN'
  })
  assert.equal((records.get('gh') as { zone: string }).zone, 'essential')
  // The folder comes before Hacker News, as in the sidebar.
  assert.ok(orders.get('docs')! < orders.get('hn')!)
})

test('a move changes only what moved', () => {
  const state = desktop()
  const orders: Orders = new Map()
  const before = byId(toRecords(state, orders))
  state.spaces[0].pinnedItems = ['hn', 'docs']
  const after = byId(toRecords(state, orders))
  const changed = [...after.keys()].filter((id) => JSON.stringify(after.get(id)) !== JSON.stringify(before.get(id)))
  assert.equal(changed.length, 1)
  assert.ok(orders.get('hn')! < orders.get('docs')!)
})

test("puts other devices' changes in place", () => {
  const state = desktop()
  const orders: Orders = new Map()
  const known = byId(toRecords(state, orders))
  applyChanges(
    state,
    [
      // A pin from the phone, at the top of the Docs folder.
      {
        record: {
          type: 'pin',
          id: 'phone-pin',
          spaceId: 'work',
          zone: 'pinned',
          parentId: 'docs',
          order: 'Zz',
          url: 'https://apple.com/',
          title: 'Apple'
        },
        previous: undefined
      },
      // Hacker News renamed, and moved into the folder after MDN.
      {
        record: {
          ...(known.get('hn') as SharedRecord & { type: 'pin' }),
          title: 'Hacker News',
          parentId: 'docs',
          order: orders.get('mdn') + 'V'
        },
        previous: known.get('hn')
      },
      // A new space.
      { record: { type: 'space', id: 'home', name: 'Home', icon: '🏡', theme, order: 'b0' }, previous: undefined }
    ],
    orders,
    make
  )
  assert.deepEqual(state.folders[0].items, ['phone-pin', 'mdn', 'hn'])
  assert.deepEqual(state.spaces[0].pinnedItems, ['docs'])
  assert.deepEqual(
    state.spaces.map((s) => s.name),
    ['Work', 'Home']
  )
  const hn = state.tabs.find((t) => t.id === 'hn')!
  assert.equal(hn.pinned?.title, 'Hacker News')
  // Back out as records, everything matches what came in: nothing to send.
  const again = byId(toRecords(state, orders))
  assert.equal(again.get('hn')!.order, orders.get('hn'))
  assert.equal((again.get('phone-pin') as { parentId: string }).parentId, 'docs')
})

test('a pin deleted elsewhere closes here, unless it is open', () => {
  const state = desktop()
  const orders: Orders = new Map()
  const known = byId(toRecords(state, orders))
  state.tabs.find((t) => t.id === 'hn')!.loaded = true
  const { removed } = applyChanges(
    state,
    [
      { record: null, previous: known.get('mdn') },
      { record: null, previous: known.get('hn') }
    ],
    orders,
    make
  )
  assert.deepEqual(
    removed.map((t) => t.id),
    ['mdn']
  )
  const hn = state.tabs.find((t) => t.id === 'hn')!
  assert.equal(hn.kind, 'normal')
  assert.equal(hn.pinned, null)
  assert.deepEqual(state.folders[0].items, [])
})
