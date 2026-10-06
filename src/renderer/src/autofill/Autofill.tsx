import { useEffect, useRef, useState } from 'react'
import type { AutofillState } from '@shared/types'
import { zepper } from '../bridge'
import { IconKey } from '../icons'
import { cx } from '../util'

/**
 * The passwords dropdown under a sign-in field, and the "Save password?" prompt after signing in.
 * It's a small view of its own so it can sit over the page without taking focus from the field:
 * the page keeps the keyboard, and passes arrow keys and Return here while the list is open.
 */
export function Autofill(): React.JSX.Element | null {
  const [state, setState] = useState<AutofillState | null>(null)
  const [dark, setDark] = useState(false)
  const [selected, setSelected] = useState(-1)
  const root = useRef<HTMLDivElement>(null)
  const current = useRef({ state, selected })
  current.current = { state, selected }

  useEffect(
    () =>
      zepper.onEvent((event) => {
        if (event.type === 'autofill.show') {
          setState(event.state)
          setDark(event.dark)
          setSelected(-1)
        } else if (event.type === 'autofill.key') {
          const { state, selected } = current.current
          if (state?.kind === 'picker') {
            if (event.key === 'Enter' && selected === 0) zepper.send({ type: 'autofill.pick' })
            else if (event.key !== 'Enter') setSelected(0)
            return
          }
          if (state?.kind !== 'logins') return
          const count = state.logins.length
          if (event.key === 'Enter') {
            if (state.logins[selected]) fill(state.logins[selected].id)
            return
          }
          const next = event.key === 'ArrowDown' ? (selected + 1) % count : selected <= 0 ? count - 1 : selected - 1
          // Keys can come faster than renders.
          current.current = { state, selected: next }
          setSelected(next)
        }
      }),
    []
  )

  // The view is sized to what it shows.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const observer = new ResizeObserver(() => zepper.send({ type: 'autofill.resize', height: Math.ceil(el.offsetHeight) }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [state])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') zepper.send({ type: 'autofill.dismiss' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!state) return null
  return (
    <div ref={root} className={cx('autofill', `autofill-${state.kind}`)} data-ui={dark ? 'dark' : 'light'}>
      {state.kind === 'logins' && (
        <>
          <div className="af-list">
            {state.logins.map((login, i) => (
              <button
                key={login.id}
                className={cx('af-row', i === selected && 'selected')}
                onMouseEnter={() => setSelected(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => fill(login.id)}
              >
                <span className="af-icon">
                  <IconKey size={13} />
                </span>
                <span className="af-text">
                  <span className="af-name">{login.username || 'No user name'}</span>
                  <span className="af-sub">{login.site}</span>
                </span>
              </button>
            ))}
          </div>
          <button
            className="af-footer"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => zepper.send({ type: 'autofill.openPasswords' })}
          >
            Passwords…
          </button>
        </>
      )}
      {state.kind === 'picker' && (
        <div className="af-list">
          <button
            className={cx('af-row', selected === 0 && 'selected')}
            onMouseEnter={() => setSelected(0)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => zepper.send({ type: 'autofill.pick' })}
          >
            <span className="af-icon">
              <IconKey size={13} />
            </span>
            <span className="af-text">
              <span className="af-name">Apple Passwords…</span>
              <span className="af-sub">Choose a saved login for {state.host}</span>
            </span>
          </button>
        </div>
      )}
      {state.kind === 'connect' && (
        <div className="af-card">
          <div className="af-head">
            <span className="af-icon large">
              <IconKey size={16} />
            </span>
            <span className="af-text">
              <span className="af-name">Use Apple Passwords</span>
              <span className="af-sub">Fill and save passwords from your iCloud Keychain, here and on your other devices.</span>
            </span>
          </div>
          {state.error && <div className="af-error">{state.error}</div>}
          <div className="af-actions">
            <button onClick={() => zepper.send({ type: 'autofill.dismiss' })}>Not now</button>
            <button className="af-primary" onClick={() => zepper.send({ type: 'autofill.connect' })}>
              Connect
            </button>
          </div>
        </div>
      )}
      {state.kind === 'pin' && <PinEntry error={state.error} hint={state.hint} />}
      {state.kind === 'save' && (
        <div className="af-card">
          <div className="af-title">
            {state.update ? 'Update' : 'Save'} password for {state.host}?
          </div>
          <div className="af-head">
            <span className="af-icon">
              <IconKey size={13} />
            </span>
            <span className="af-text">
              <span className="af-name">{state.username || 'No user name'}</span>
              <span className="af-sub">Saved in Apple Passwords and synced with your devices.</span>
            </span>
          </div>
          <div className="af-actions">
            {!state.update && (
              <button className="af-quiet" onClick={() => zepper.send({ type: 'autofill.save', choice: 'never' })}>
                Never for this site
              </button>
            )}
            <span className="af-spacer" />
            <button onClick={() => zepper.send({ type: 'autofill.save', choice: 'later' })}>Not now</button>
            <button className="af-primary" onClick={() => zepper.send({ type: 'autofill.save', choice: 'save' })}>
              {state.update ? 'Update' : 'Save'}
            </button>
          </div>
        </div>
      )}
      {state.kind === 'unavailable' && (
        <div className="af-card">
          <div className="af-head">
            <span className="af-icon large">
              <IconKey size={16} />
            </span>
            <span className="af-text">
              <span className="af-name">Apple Passwords isn’t available</span>
              <span className="af-sub">{state.reason}</span>
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function fill(loginId: string): void {
  zepper.send({ type: 'autofill.fill', loginId })
}

/** Connecting to Apple Passwords: macOS shows a six-digit code, typed here once. */
function PinEntry({ error, hint }: { error?: string; hint?: string }): React.JSX.Element {
  const [pin, setPin] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  return (
    <div className="af-card">
      <div className="af-title">Enter the code from macOS</div>
      <div className="af-sub">{hint ?? 'macOS is showing a six-digit code. Type it here to connect Zepper to Apple Passwords.'}</div>
      <input
        ref={input}
        className={cx('af-pin', error && 'invalid')}
        value={pin}
        inputMode="numeric"
        autoComplete="one-time-code"
        spellCheck={false}
        maxLength={6}
        placeholder="••••••"
        onChange={(e) => {
          const next = e.target.value.replace(/\D/g, '').slice(0, 6)
          // Sent once complete; the field clears for another try if it's wrong.
          setPin(next.length === 6 ? '' : next)
          if (next.length === 6) zepper.send({ type: 'autofill.pin', pin: next })
        }}
      />
      {error && <div className="af-error">{error}</div>}
      <div className="af-actions">
        <span className="af-spacer" />
        <button onClick={() => zepper.send({ type: 'autofill.dismiss' })}>Cancel</button>
      </div>
    </div>
  )
}
