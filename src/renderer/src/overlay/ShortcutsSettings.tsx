import { useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { Settings } from '@shared/settings'
import {
  SHORTCUT_COMMANDS,
  acceleratorFor,
  acceleratorLabel,
  defaultAccelerator,
  shortcutClashes,
  type ShortcutCommand
} from '@shared/shortcuts'
import { zepper } from '../bridge'
import { cx } from '../util'

/**
 * Settings › Shortcuts: every command's shortcut, which you can change. Click one and press the new
 * keys (⌫ takes it off, Esc keeps it); keys another command has are offered to swap over, the menus'
 * own (Copy, Quit) aren't yours to give, and the system's are allowed with a warning, as it may take
 * them first.
 */
export function ShortcutsSettings({ settings }: { settings: Settings }): React.JSX.Element {
  const platform = zepper.platform
  const custom = settings.shortcuts
  const [recording, setRecording] = useState<string | null>(null)
  /** Keys held while recording, before the key that finishes it. */
  const [held, setHeld] = useState('')
  /** Keys you pressed that another command has: swap them over, or not. */
  const [offer, setOffer] = useState<{ id: string; accelerator: string; others: ShortcutCommand[] } | null>(null)
  /** Why the keys you pressed weren't taken. */
  const [refused, setRefused] = useState<{ id: string; text: string } | null>(null)
  const [filter, setFilter] = useState('')

  const save = (patch: Record<string, string | undefined>): void => {
    const next = { ...custom }
    for (const [id, accelerator] of Object.entries(patch)) {
      const command = SHORTCUT_COMMANDS.find((c) => c.id === id)
      // Back to its own: no entry at all, so a later change to its default reaches it.
      if (accelerator === undefined || (command && accelerator === defaultAccelerator(command, platform))) delete next[id]
      else next[id] = accelerator
    }
    zepper.send({ type: 'settings.update', patch: { shortcuts: next } })
  }

  // While recording, the keys come from the main process (they never reach the page or the menu).
  useEffect(() => {
    if (!recording) return
    zepper.send({ type: 'shortcuts.record', on: true })
    const stop = zepper.onEvent((event) => {
      if (event.type !== 'shortcuts.key') return
      const key = keyOf(event.code)
      const mods = modifiersOf(event, platform)
      if (!key) return setHeld(acceleratorLabel([...mods, ''].join('+'), platform).replace(/\+$/, ''))
      const plain = mods.length === 0 || (mods.length === 1 && mods[0] === 'Shift')
      if (plain && key === 'Escape') return setRecording(null)
      if (mods.length === 0 && (key === 'Backspace' || key === 'Delete')) {
        save({ [recording]: '' })
        return setRecording(null)
      }
      if (plain && !/^F\d+$/.test(key)) {
        setHeld('')
        return setRefused({ id: recording, text: `Include ${platform === 'darwin' ? '⌘, ⌥ or ⌃' : 'Ctrl or Alt'}, so it isn't typing.` })
      }
      const accelerator = [...mods, key].join('+')
      const clash = shortcutClashes(accelerator, recording, custom, platform)
      const fixed = clash.reserved.find((r) => !r.system)
      setHeld('')
      if (fixed) {
        setRefused({ id: recording, text: `${acceleratorLabel(accelerator, platform)} is ${fixed.label}’s, which can’t be changed.` })
        return
      }
      setRefused(null)
      setRecording(null)
      if (clash.commands.length > 0) return setOffer({ id: recording, accelerator, others: clash.commands })
      save({ [recording]: accelerator })
    })
    // Clicking anywhere else stops it.
    const away = (): void => setRecording(null)
    window.addEventListener('blur', away)
    return () => {
      stop()
      window.removeEventListener('blur', away)
      zepper.send({ type: 'shortcuts.record', on: false })
    }
  }, [recording, custom, platform])

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const shown = SHORTCUT_COMMANDS.filter((c) => {
      if (!needle) return true
      const keys = acceleratorFor(c.id, custom, platform)
      return c.label.toLowerCase().includes(needle) || (keys !== null && acceleratorLabel(keys, platform).toLowerCase().includes(needle))
    })
    const byGroup = new Map<string, ShortcutCommand[]>()
    for (const command of shown) byGroup.set(command.group, [...(byGroup.get(command.group) ?? []), command])
    return [...byGroup]
  }, [filter, custom, platform])

  const changed = Object.keys(custom).length > 0

  return (
    <div className="shortcuts">
      <div className="shortcuts-tools">
        <input
          className="settings-input shortcuts-filter"
          placeholder="Search shortcuts"
          value={filter}
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
        />
        {changed && (
          <button
            className="panel-button"
            onClick={() => {
              setOffer(null)
              setRefused(null)
              zepper.send({ type: 'settings.update', patch: { shortcuts: {} } })
            }}
          >
            Restore Defaults
          </button>
        )}
      </div>
      <p className="shortcuts-note">Click a shortcut, then press the keys you want. ⌫ removes it; Esc leaves it as it is.</p>

      {groups.map(([group, commands]) => (
        <section key={group} className="shortcut-group">
          <h3 className="shortcut-group-title">{group}</h3>
          <div className="shortcut-list">
            {commands.map((command) => {
              const keys = acceleratorFor(command.id, custom, platform)
              const own = defaultAccelerator(command, platform)
              const isRecording = recording === command.id
              const clash = keys ? shortcutClashes(keys, command.id, custom, platform) : null
              const system = clash?.reserved.find((r) => r.system)
              return (
                <div key={command.id} className="shortcut-item">
                  <div className="shortcut-row">
                    <span>{command.label}</span>
                    <span className="shortcut-controls">
                      {command.id in custom && (
                        <button
                          className="shortcut-reset"
                          title={`Back to ${acceleratorLabel(own, platform)}`}
                          onClick={() => save({ [command.id]: undefined })}
                        >
                          <RotateCcw size={12} />
                        </button>
                      )}
                      <button
                        className={cx('shortcut-key', isRecording && 'recording', !keys && 'none')}
                        onClick={() => {
                          setOffer(null)
                          setRefused(null)
                          setHeld('')
                          setRecording(isRecording ? null : command.id)
                        }}
                      >
                        {isRecording ? held || 'Press keys…' : keys ? acceleratorLabel(keys, platform) : 'None'}
                      </button>
                    </span>
                  </div>
                  {refused?.id === command.id && <div className="shortcut-message">{refused.text}</div>}
                  {offer?.id === command.id && (
                    <div className="shortcut-message shortcut-offer">
                      <span>
                        {acceleratorLabel(offer.accelerator, platform)} is {offer.others.map((o) => o.label).join(' and ')}’s shortcut.
                      </span>
                      <span className="shortcut-offer-buttons">
                        <button className="panel-button" onClick={() => setOffer(null)}>
                          Cancel
                        </button>
                        <button
                          className="panel-button primary"
                          onClick={() => {
                            save({ [offer.id]: offer.accelerator, ...Object.fromEntries(offer.others.map((o) => [o.id, ''])) })
                            setOffer(null)
                          }}
                        >
                          Use Here
                        </button>
                      </span>
                    </div>
                  )}
                  {!isRecording && clash && clash.commands.length > 0 && (
                    <div className="shortcut-message warn">Same as {clash.commands.map((c) => c.label).join(' and ')}.</div>
                  )}
                  {!isRecording && system && (
                    <div className="shortcut-message warn">
                      {platform === 'darwin' ? 'macOS' : 'Your desktop'} uses this for {system.label}, so it may not reach Zepper.
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ))}
      {groups.length === 0 && <p className="shortcuts-note">No shortcuts match.</p>}
    </div>
  )
}

/** The modifiers held, as an accelerator's (⌘ is CmdOrCtrl on a Mac; on Linux Ctrl is). */
function modifiersOf(event: { meta: boolean; control: boolean; alt: boolean; shift: boolean }, platform: string): string[] {
  const mods: string[] = []
  if (platform === 'darwin' ? event.meta : event.control) mods.push('CmdOrCtrl')
  if (platform === 'darwin' && event.control) mods.push('Control')
  if (event.alt) mods.push('Alt')
  if (event.shift) mods.push('Shift')
  return mods
}

const CODE_KEYS: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  Tab: 'Tab',
  Enter: 'Return',
  NumpadEnter: 'Return',
  Space: 'Space',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Home: 'Home',
  End: 'End'
}

/**
 * The key pressed, by where it is on the keyboard (⌥ changes the character it types: ⌥R is ®), as an
 * accelerator's key, or null for a modifier on its own.
 */
function keyOf(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^F\d{1,2}$/.test(code)) return code
  return CODE_KEYS[code] ?? null
}
