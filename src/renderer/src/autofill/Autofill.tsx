import { useEffect, useMemo, useRef, useState } from 'react'
import qrcode from 'qrcode-generator'
import type { AutofillItem, AutofillState, PhoneStatus } from '@shared/types'
import { zepper } from '../bridge'
import { IconCheck, IconKey, IconPasskey, IconPhone, IconSparkle } from '../icons'
import { cx } from '../util'

/**
 * Zepper's password popup: the dropdown under a sign-in field, the "Save password?" prompt after
 * signing in, and the sheets for creating and using passkeys. It's a small window of its own so it
 * can sit over the page without taking focus from the field: the page keeps the keyboard, and
 * passes arrow keys and Return here while the list is open.
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
          if (state?.kind !== 'list') return
          if (event.key === 'Enter') {
            if (state.items[selected]) zepper.send({ type: 'autofill.choose', index: selected })
            return
          }
          const count = state.items.length
          const next = event.key === 'ArrowDown' ? (selected + 1) % count : selected <= 0 ? count - 1 : selected - 1
          // Keys can come faster than renders.
          current.current = { state, selected: next }
          setSelected(next)
        }
      }),
    []
  )

  // The window is sized to what it shows.
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
      {state.kind === 'list' && (
        <>
          <div className="af-list">
            {state.items.map((item, i) => (
              <button
                key={item.kind === 'generate' ? 'generate' : `${item.kind}:${item.id}`}
                className={cx('af-row', i === selected && 'selected')}
                onMouseEnter={() => setSelected(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => zepper.send({ type: 'autofill.choose', index: i })}
              >
                <ItemRow item={item} />
              </button>
            ))}
          </div>
          <button className="af-footer" onMouseDown={(e) => e.preventDefault()} onClick={() => zepper.send({ type: 'autofill.manage' })}>
            Manage passwords…
          </button>
        </>
      )}
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
              <span className="af-sub">Saved in Zepper on this Mac, encrypted with your Keychain.</span>
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
      {state.kind === 'saved' && (
        <div className="af-card">
          <div className="af-head">
            <span className="af-icon">
              <IconCheck size={14} />
            </span>
            <span className="af-text">
              <span className="af-name">Password saved</span>
              <span className="af-sub">{state.username ? `${state.username} on ${state.host}` : state.host}, in Zepper’s passwords.</span>
            </span>
          </div>
        </div>
      )}
      {state.kind === 'passkeyCreate' && (
        <div className="af-card">
          <div className="af-head">
            <span className="af-icon large">
              <IconPasskey size={17} />
            </span>
            <span className="af-text">
              <span className="af-name">Create a passkey for {state.rpId}?</span>
              <span className="af-sub">
                {state.userName ? <strong>{state.userName}</strong> : 'Your account'} · saved in Zepper on this Mac. You’ll sign in with
                Touch ID instead of a password.
              </span>
            </span>
          </div>
          <div className="af-actions">
            <OtherDevices other={state.other} />
            <span className="af-spacer" />
            <button onClick={() => zepper.send({ type: 'autofill.dismiss' })}>Cancel</button>
            <button className="af-primary" onClick={() => zepper.send({ type: 'autofill.passkeyCreate' })}>
              Continue
            </button>
          </div>
        </div>
      )}
      {state.kind === 'passkeyGet' && (
        <div className="af-card">
          <div className="af-head">
            <span className="af-icon large">
              <IconPasskey size={17} />
            </span>
            <span className="af-text">
              <span className="af-name">Sign in to {state.rpId}</span>
              <span className="af-sub">
                {state.passkeys.length ? 'Choose a passkey saved in Zepper.' : `No passkeys for ${state.rpId} are saved in Zepper.`}
              </span>
            </span>
          </div>
          {state.passkeys.length > 0 && (
            <div className="af-choices">
              {state.passkeys.map((passkey) => (
                <button key={passkey.id} className="af-row" onClick={() => zepper.send({ type: 'autofill.passkeyChoose', id: passkey.id })}>
                  <span className="af-icon">
                    <IconPasskey size={13} />
                  </span>
                  <span className="af-text">
                    <span className="af-name">{passkey.userName || passkey.displayName || 'Passkey'}</span>
                    {passkey.displayName && passkey.displayName !== passkey.userName && (
                      <span className="af-sub">{passkey.displayName}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="af-actions">
            <OtherDevices other={state.other} />
            <span className="af-spacer" />
            <button onClick={() => zepper.send({ type: 'autofill.dismiss' })}>Cancel</button>
          </div>
        </div>
      )}
      {state.kind === 'passkeyPhone' && <PhoneSheet state={state} />}
    </div>
  )
}

/** Other places a passkey can come from: a phone (QR code), or macOS's own (with Apple's browser entitlement). */
function OtherDevices({ other }: { other: boolean }): React.JSX.Element {
  return (
    <>
      <button className="af-quiet" onClick={() => zepper.send({ type: 'autofill.passkeyPhone' })}>
        Use a phone…
      </button>
      {other && (
        <button className="af-quiet" onClick={() => zepper.send({ type: 'autofill.passkeyOther' })}>
          Other device…
        </button>
      )}
    </>
  )
}

const PHONE_STATUS: Record<PhoneStatus, string> = {
  scan: 'Scan this code with your phone’s camera. Bluetooth needs to be on, on both devices.',
  connecting: 'Connecting to your phone…',
  confirm: 'Continue on your phone.',
  error: ''
}

/** Signing in with a phone's passkey: the QR code it scans, then where things are. */
function PhoneSheet({ state }: { state: Extract<AutofillState, { kind: 'passkeyPhone' }> }): React.JSX.Element {
  const svg = useMemo(() => {
    const code = qrcode(0, 'L')
    code.addData(state.qr, 'Alphanumeric')
    code.make()
    return code.createSvgTag({ cellSize: 4, margin: 0, scalable: true })
  }, [state.qr])
  return (
    <div className="af-card">
      <div className="af-head">
        <span className="af-icon large">
          <IconPhone size={17} />
        </span>
        <span className="af-text">
          <span className="af-name">{state.create ? 'Save a passkey on your phone' : 'Use a passkey from your phone'}</span>
          <span className="af-sub">{state.rpId}</span>
        </span>
      </div>
      {state.status === 'scan' && <div className="af-qr" dangerouslySetInnerHTML={{ __html: svg }} />}
      <div className={cx('af-phone-status', state.status === 'error' && 'af-error')}>
        {state.status === 'error' ? state.error : PHONE_STATUS[state.status]}
      </div>
      <div className="af-actions">
        <span className="af-spacer" />
        <button onClick={() => zepper.send({ type: 'autofill.dismiss' })}>Cancel</button>
      </div>
    </div>
  )
}

function ItemRow({ item }: { item: AutofillItem }): React.JSX.Element {
  if (item.kind === 'generate') {
    return (
      <>
        <span className="af-icon">
          <IconSparkle size={13} />
        </span>
        <span className="af-text">
          <span className="af-name">Use strong password</span>
          <span className="af-sub af-mono">{item.password}</span>
        </span>
      </>
    )
  }
  return (
    <>
      <span className="af-icon">{item.kind === 'passkey' ? <IconPasskey size={13} /> : <IconKey size={13} />}</span>
      <span className="af-text">
        <span className="af-name">{item.username || 'No user name'}</span>
        <span className="af-sub">
          {item.kind === 'passkey' ? 'Passkey · ' : ''}
          {item.site}
        </span>
      </span>
    </>
  )
}
