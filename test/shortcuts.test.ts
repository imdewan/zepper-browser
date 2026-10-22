/// <reference types="node" />
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  SHORTCUT_COMMANDS,
  acceleratorFor,
  acceleratorLabel,
  chordOf,
  defaultAccelerator,
  macToAccelerator,
  reservedShortcuts,
  shortcutClashes
} from '../src/shared/shortcuts'

test('Mac-written shortcuts become accelerators', () => {
  assert.equal(macToAccelerator('⇧⌘T'), 'CmdOrCtrl+Shift+T')
  assert.equal(macToAccelerator('⌃⇥'), 'Control+Tab')
  assert.equal(macToAccelerator('⌥⌘↓'), 'CmdOrCtrl+Alt+Down')
  assert.equal(macToAccelerator('⌘+'), 'CmdOrCtrl+Plus')
  assert.equal(macToAccelerator('⌘,'), 'CmdOrCtrl+,')
  assert.equal(macToAccelerator('⌃⇧='), 'Control+Shift+=')
})

test('accelerators are labelled as each platform writes them', () => {
  assert.equal(acceleratorLabel('CmdOrCtrl+Shift+T', 'darwin'), '⇧⌘T')
  assert.equal(acceleratorLabel('CmdOrCtrl+Alt+Shift+D', 'darwin'), '⌥⇧⌘D')
  assert.equal(acceleratorLabel('Control+Tab', 'darwin'), '⌃⇥')
  assert.equal(acceleratorLabel('CmdOrCtrl+Plus', 'darwin'), '⌘+')
  assert.equal(acceleratorLabel('CmdOrCtrl+Shift+T', 'linux'), 'Ctrl+Shift+T')
  assert.equal(acceleratorLabel('Ctrl+PageDown', 'linux'), 'Ctrl+Page Down')
})

for (const platform of ['darwin', 'linux']) {
  test(`no two default shortcuts are the same keys (${platform})`, () => {
    const seen = new Map<string, string>()
    for (const command of SHORTCUT_COMMANDS) {
      const chord = chordOf(defaultAccelerator(command, platform), platform)
      assert.equal(seen.get(chord), undefined, `${command.label} and ${seen.get(chord)} are both ${chord}`)
      seen.set(chord, command.label)
    }
  })

  test(`no default shortcut is one of the menus' or the system's (${platform})`, () => {
    for (const command of SHORTCUT_COMMANDS) {
      const { commands, reserved } = shortcutClashes(defaultAccelerator(command, platform), command.id, {}, platform)
      assert.deepEqual(commands, [], `${command.label} clashes with ${commands.map((c) => c.label).join(', ')}`)
      assert.deepEqual(reserved, [], `${command.label} clashes with ${reserved.map((r) => r.label).join(', ')}`)
    }
  })
}

test('your shortcuts replace the defaults, and an empty one takes the shortcut off', () => {
  const custom = { newTab: 'CmdOrCtrl+Shift+Y', pinTab: '' }
  assert.equal(acceleratorFor('newTab', custom, 'darwin'), 'CmdOrCtrl+Shift+Y')
  assert.equal(acceleratorFor('pinTab', custom, 'darwin'), null)
  assert.equal(acceleratorFor('reopenTab', custom, 'darwin'), 'CmdOrCtrl+Shift+T')
})

test('a clash is found however the shortcut is spelled', () => {
  const clash = shortcutClashes('Shift+CmdOrCtrl+T', 'newTab', {}, 'darwin')
  assert.deepEqual(
    clash.commands.map((c) => c.id),
    ['reopenTab']
  )
  // On Linux ⌘ and ⌃ are both Ctrl.
  assert.equal(chordOf('Control+T', 'linux'), chordOf('CmdOrCtrl+T', 'linux'))
  assert.notEqual(chordOf('Control+T', 'darwin'), chordOf('CmdOrCtrl+T', 'darwin'))
  assert.ok(reservedShortcuts('darwin').some((r) => r.system && chordOf(r.accelerator, 'darwin') === '⇧⌘3'))
})
