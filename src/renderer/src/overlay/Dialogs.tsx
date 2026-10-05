import { useEffect, useRef, useState } from 'react'
import type { AuthSpec, JsDialogSpec } from '@shared/types'
import { zepper } from '../bridge'
import { IconClose, IconLock } from '../icons'

/** A page's alert(), confirm() or prompt(): "example.com says…", like Chrome. Return answers, Esc cancels. */
export function JsDialog({ dialog, onDone }: { dialog: JsDialogSpec; onDone: () => void }): React.JSX.Element {
  const [value, setValue] = useState(dialog.defaultValue)
  const [suppress, setSuppress] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const ok = useRef<HTMLButtonElement>(null)

  const respond = (accepted: boolean): void => {
    zepper.send({ type: 'dialog.respond', id: dialog.id, ok: accepted, value, suppress })
    onDone()
  }

  useEffect(() => {
    if (dialog.kind === 'prompt') {
      input.current?.focus()
      input.current?.select()
    } else {
      ok.current?.focus()
    }
  }, [dialog])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        respond(false)
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        respond(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="js-dialog">
      <button className="popover-close" title={dialog.kind === 'alert' ? 'Close' : 'Cancel'} onClick={() => respond(false)}>
        <IconClose size={13} />
      </button>
      <div className="js-dialog-title">{dialog.embedded ? `An embedded page at ${dialog.host} says` : `${dialog.host} says`}</div>
      {dialog.message && <div className="js-dialog-message">{dialog.message}</div>}
      {dialog.kind === 'prompt' && (
        <input ref={input} className="dialog-input" value={value} spellCheck={false} onChange={(e) => setValue(e.target.value)} />
      )}
      {dialog.offerSuppress && (
        <label className="js-dialog-suppress">
          <input type="checkbox" checked={suppress} onChange={(e) => setSuppress(e.target.checked)} />
          Don’t let this page show more dialogs
        </label>
      )}
      <div className="permission-buttons">
        {dialog.kind !== 'alert' && (
          <button className="panel-button" onClick={() => respond(false)}>
            Cancel
          </button>
        )}
        <button ref={ok} className="panel-button primary" onClick={() => respond(true)}>
          OK
        </button>
      </div>
    </div>
  )
}

/** HTTP authentication: the site (or a proxy) wants a username and password. */
export function AuthDialog({ auth, onDone }: { auth: AuthSpec; onDone: () => void }): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const respond = (signIn: boolean): void => {
    zepper.send({ type: 'auth.respond', id: auth.id, username: signIn ? username : null, password: signIn ? password : '' })
    onDone()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        respond(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <form
      className="js-dialog auth-dialog"
      onSubmit={(e) => {
        e.preventDefault()
        respond(true)
      }}
    >
      <button type="button" className="popover-close" title="Cancel" onClick={() => respond(false)}>
        <IconClose size={13} />
      </button>
      <div className="auth-header">
        <IconLock size={15} />
        <span>Sign in</span>
      </div>
      <div className="js-dialog-message">
        {auth.isProxy ? 'The proxy ' : ''}
        <strong>{auth.host}</strong> requires a username and password.
        {auth.realm && <span className="auth-realm"> It says: “{auth.realm}”</span>}
      </div>
      <input
        className="dialog-input"
        placeholder="Username"
        autoComplete="username"
        autoFocus
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <input
        className="dialog-input"
        placeholder="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <div className="permission-buttons">
        <button type="button" className="panel-button" onClick={() => respond(false)}>
          Cancel
        </button>
        <button type="submit" className="panel-button primary">
          Sign In
        </button>
      </div>
    </form>
  )
}
