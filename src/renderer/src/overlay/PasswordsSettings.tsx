import { useEffect, useState } from 'react'
import type { Settings } from '@shared/settings'
import type { ImportResult, ImportSource, LoginSummary, VaultReplies } from '@shared/types'
import { zepper } from '../bridge'
import { IconClose, IconCopy, IconKey, IconPasskey, IconPlus, IconSearch } from '../icons'
import { cx } from '../util'
import { SiteListLink } from './SiteListPage'
import { Toggle } from './Toggle'

/**
 * Settings › Passwords: Zepper's password manager. Saved passwords (search, show with Touch ID,
 * copy, edit, delete), passkeys, importing from other browsers and password exports, and exporting.
 */
export function PasswordsSettings({ settings, onOpenNeverSaved }: { settings: Settings; onOpenNeverSaved: () => void }): React.JSX.Element {
  const [data, setData] = useState<VaultReplies['list'] | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const refresh = (): void => {
    void zepper.vault({ type: 'list' }).then(setData)
  }
  useEffect(refresh, [])
  const set = (patch: Partial<Settings>): void => zepper.send({ type: 'settings.update', patch })

  const needle = query.trim().toLowerCase()
  const logins = (data?.logins ?? []).filter((l) => !needle || l.host.includes(needle) || l.username.toLowerCase().includes(needle))
  const passkeys = (data?.passkeys ?? []).filter((p) => !needle || p.rpId.includes(needle) || p.userName.toLowerCase().includes(needle))

  const exportAll = async (): Promise<void> => {
    const reply = await zepper.vault({ type: 'export' })
    if (reply.saved) setNotice(`Exported to ${reply.saved.replace(/^.*\//, '')}. Delete the file once you’ve used it: it isn’t encrypted.`)
    else if (reply.error) setNotice(reply.error)
  }

  return (
    <>
      <div className="settings-row">
        <div className="settings-row-text">
          <div className="settings-row-label">Offer to save and fill passwords</div>
          <div className="settings-row-hint">
            Kept on this Mac, encrypted with a key in your Keychain. Showing or exporting them asks for Touch ID or your Mac’s password.
          </div>
        </div>
        <div className="settings-row-control">
          <Toggle checked={settings.passwords} onChange={(passwords) => set({ passwords })} />
        </div>
      </div>

      <div className="pw-toolbar">
        <label className="pw-search">
          <IconSearch size={13} />
          <input value={query} placeholder="Search passwords" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button className="panel-button" title="Add a password" onClick={() => setAdding(true)}>
          <IconPlus size={13} />
        </button>
        <button className="panel-button" onClick={() => setImporting((v) => !v)}>
          Import…
        </button>
        <button className="panel-button" disabled={!data?.logins.length} onClick={() => void exportAll()}>
          Export…
        </button>
      </div>

      {notice && (
        <div className="pw-notice">
          <span>{notice}</span>
          <button title="Dismiss" onClick={() => setNotice(null)}>
            <IconClose size={10} />
          </button>
        </div>
      )}

      {importing && (
        <ImportPanel
          onDone={(text) => {
            setNotice(text)
            setImporting(false)
            refresh()
          }}
          onClose={() => setImporting(false)}
        />
      )}

      {adding && (
        <LoginEditor
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            refresh()
          }}
        />
      )}

      <div className="pw-list">
        {data !== null && data.logins.length === 0 && !adding && (
          <p className="pw-empty">
            No saved passwords yet. Zepper offers to save them when you sign in, or import them from another browser.
          </p>
        )}
        {data !== null && data.logins.length > 0 && logins.length === 0 && <p className="pw-empty">No passwords match.</p>}
        {logins.map((login) =>
          open === login.id ? (
            <LoginEditor
              key={login.id}
              login={login}
              onClose={() => setOpen(null)}
              onSaved={() => {
                setOpen(null)
                refresh()
              }}
            />
          ) : (
            <button key={login.id} className="pw-row" onClick={() => setOpen(login.id)}>
              <SiteAvatar host={login.host} />
              <span className="pw-row-text">
                <span className="pw-host">{login.host.replace(/^www\./, '')}</span>
                <span className="pw-user">{login.username || 'No user name'}</span>
              </span>
            </button>
          )
        )}
      </div>

      {passkeys.length > 0 && (
        <>
          <h3 className="pw-heading">Passkeys</h3>
          <div className="pw-list">
            {passkeys.map((passkey) => (
              <div key={passkey.id} className="pw-row static">
                <span className="pw-avatar passkey">
                  <IconPasskey size={14} />
                </span>
                <span className="pw-row-text">
                  <span className="pw-host">{passkey.rpId}</span>
                  <span className="pw-user">
                    {passkey.userName || passkey.displayName || 'Passkey'} · created {new Date(passkey.created).toLocaleDateString()}
                  </span>
                </span>
                <ConfirmButton
                  label="Delete"
                  confirm="Delete passkey?"
                  onConfirm={() => void zepper.vault({ type: 'deletePasskey', id: passkey.id }).then(refresh)}
                />
              </div>
            ))}
          </div>
        </>
      )}

      <SiteListLink
        label="Never saved for"
        hint="Sites where Zepper doesn’t offer to save passwords."
        count={settings.neverSavePasswords.length}
        onOpen={onOpenNeverSaved}
      />
    </>
  )
}

function SiteAvatar({ host }: { host: string }): React.JSX.Element {
  const name = host.replace(/^www\./, '')
  // A steady colour per site.
  let hash = 0
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) | 0
  return (
    <span className="pw-avatar" style={{ background: `hsl(${Math.abs(hash) % 360} 45% 52%)` }}>
      {name[0]?.toUpperCase() ?? '?'}
    </span>
  )
}

/** A button that asks once more before doing something you can't undo. */
function ConfirmButton({ label, confirm, onConfirm }: { label: string; confirm: string; onConfirm: () => void }): React.JSX.Element {
  const [asking, setAsking] = useState(false)
  useEffect(() => {
    if (!asking) return
    const timer = setTimeout(() => setAsking(false), 3000)
    return () => clearTimeout(timer)
  }, [asking])
  return (
    <button className={cx('pw-link danger', asking && 'asking')} onClick={() => (asking ? onConfirm() : setAsking(true))}>
      {asking ? confirm : label}
    </button>
  )
}

/** One saved password, opened: show (with Touch ID), copy, edit, delete. Or a new one, when there's no login. */
function LoginEditor({ login, onClose, onSaved }: { login?: LoginSummary; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const [url, setUrl] = useState(login?.origin ?? '')
  const [username, setUsername] = useState(login?.username ?? '')
  const [password, setPassword] = useState<string | null>(login ? null : '')
  const [note, setNote] = useState(login?.note ?? '')
  const [shown, setShown] = useState(!login)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  /** The password, asking for Touch ID the first time. */
  const reveal = async (): Promise<string | null> => {
    if (password !== null) return password
    if (!login) return ''
    const reply = await zepper.vault({ type: 'reveal', id: login.id })
    if ('error' in reply) {
      if (reply.error !== 'Not unlocked.') setError(reply.error)
      return null
    }
    setPassword(reply.password)
    return reply.password
  }
  const copy = async (what: 'username' | 'password'): Promise<void> => {
    const text = what === 'username' ? username : await reveal()
    if (text === null) return
    zepper.send({ type: 'clipboard.write', text })
    setCopied(what)
    setTimeout(() => setCopied(null), 1500)
  }
  const save = async (): Promise<void> => {
    const reply = login
      ? await zepper.vault({ type: 'update', id: login.id, url, username, password: password ?? undefined, note })
      : await zepper.vault({ type: 'add', url, username, password: password ?? '' })
    if (reply.error) setError(reply.error)
    else onSaved()
  }

  return (
    <div className="pw-editor">
      <div className="pw-editor-head">
        {login ? (
          <SiteAvatar host={login.host} />
        ) : (
          <span className="pw-avatar passkey">
            <IconKey size={14} />
          </span>
        )}
        <span className="pw-host">{login ? login.host.replace(/^www\./, '') : 'New password'}</span>
        <button className="pw-close" title="Close" onClick={onClose}>
          <IconClose size={11} />
        </button>
      </div>
      <label className="pw-field">
        <span>Website</span>
        <input value={url} placeholder="example.com" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label className="pw-field">
        <span>User name</span>
        <input value={username} spellCheck={false} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
        {login && (
          <button className="pw-icon-button" title="Copy user name" onClick={() => void copy('username')}>
            {copied === 'username' ? '✓' : <IconCopy size={12} />}
          </button>
        )}
      </label>
      <label className="pw-field">
        <span>Password</span>
        <input
          value={shown && password !== null ? password : '••••••••••••'}
          type={shown ? 'text' : 'password'}
          readOnly={!shown || password === null}
          spellCheck={false}
          autoComplete="off"
          className="pw-secret"
          onChange={(e) => setPassword(e.target.value)}
        />
        {login && (
          <>
            <button
              className="pw-text-button"
              onClick={() => {
                if (shown) setShown(false)
                else void reveal().then((value) => value !== null && setShown(true))
              }}
            >
              {shown ? 'Hide' : 'Show'}
            </button>
            <button className="pw-icon-button" title="Copy password" onClick={() => void copy('password')}>
              {copied === 'password' ? '✓' : <IconCopy size={12} />}
            </button>
          </>
        )}
      </label>
      {login && (
        <label className="pw-field">
          <span>Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      )}
      {error && <div className="pw-error">{error}</div>}
      <div className="pw-editor-actions">
        {login && (
          <ConfirmButton
            label="Delete"
            confirm="Delete password?"
            onConfirm={() => void zepper.vault({ type: 'delete', id: login.id }).then(onSaved)}
          />
        )}
        <span className="af-spacer" />
        <button className="panel-button" onClick={onClose}>
          Cancel
        </button>
        <button className="panel-button primary" onClick={() => void save()}>
          {login ? 'Save' : 'Add'}
        </button>
      </div>
    </div>
  )
}

function describe(result: ImportResult): string {
  const parts = [`Imported ${result.added} password${result.added === 1 ? '' : 's'}.`]
  if (result.skipped) parts.push(`${result.skipped} ${result.skipped === 1 ? 'was' : 'were'} already saved.`)
  if (result.conflicts) parts.push(`${result.conflicts} already saved with a different password kept Zepper’s.`)
  if (result.invalid) parts.push(`${result.invalid} couldn’t be imported (not a website login).`)
  return parts.join(' ')
}

/** Import from browsers on this Mac, or from a passwords file. */
function ImportPanel({ onDone, onClose }: { onDone: (notice: string) => void; onClose: () => void }): React.JSX.Element {
  const [sources, setSources] = useState<ImportSource[] | null>(null)
  const [profiles, setProfiles] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void zepper.vault({ type: 'sources' }).then((list) => setSources(list.filter((source) => source.kinds.includes('passwords'))))
  }, [])

  const fromBrowser = async (source: ImportSource): Promise<void> => {
    setBusy(source.id)
    setError(null)
    const reply = await zepper.vault({ type: 'importBrowser', source: source.id, profile: profiles[source.id] ?? source.profiles[0].dir })
    setBusy(null)
    if ('error' in reply) setError(reply.error)
    else onDone(`${source.name}: ${describe(reply)}`)
  }
  const fromFile = async (): Promise<void> => {
    setBusy('file')
    setError(null)
    const reply = await zepper.vault({ type: 'importFile' })
    setBusy(null)
    if (reply === null) return
    if ('error' in reply) setError(reply.error)
    else onDone(describe(reply))
  }

  return (
    <div className="pw-import">
      <div className="pw-editor-head">
        <span className="pw-host">Import passwords</span>
        <button className="pw-close" title="Close" onClick={onClose}>
          <IconClose size={11} />
        </button>
      </div>
      {sources !== null && sources.length > 0 && (
        <div className="pw-sources">
          {sources.map((source) =>
            source.blocked ? (
              <div key={source.id} className="pw-source">
                <span className="pw-source-name">
                  {source.name}
                  <span className="pw-source-note">macOS needs your permission to read it</span>
                </span>
                <button className="panel-button" onClick={() => void zepper.vault({ type: 'openPrivacySettings' })}>
                  Allow…
                </button>
              </div>
            ) : (
              <div key={source.id} className="pw-source">
                <span className="pw-source-name">{source.name}</span>
                {source.profiles.length > 1 && (
                  <select
                    value={profiles[source.id] ?? source.profiles[0].dir}
                    onChange={(e) => setProfiles({ ...profiles, [source.id]: e.target.value })}
                  >
                    {source.profiles.map((profile) => (
                      <option key={profile.dir} value={profile.dir}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                )}
                <button className="panel-button" disabled={busy !== null} onClick={() => void fromBrowser(source)}>
                  {busy === source.id ? 'Importing…' : 'Import'}
                </button>
              </div>
            )
          )}
          <p className="pw-hint">
            macOS asks you to allow access to the browser’s key in your Keychain; choose Allow.
            {sources.some((s) => s.blocked) &&
              ' For browsers macOS protects, turn on Zepper in Privacy & Security › Full Disk Access, then reopen this panel.'}
          </p>
        </div>
      )}
      <div className="pw-source">
        <span className="pw-source-name">From a file</span>
        <button className="panel-button" disabled={busy !== null} onClick={() => void fromFile()}>
          {busy === 'file' ? 'Importing…' : 'Choose File…'}
        </button>
      </div>
      <p className="pw-hint">
        <strong>Apple Passwords or Safari:</strong> in the Passwords app, choose File › Export All Passwords. <strong>Firefox:</strong>{' '}
        Passwords › ⋯ › Export Passwords. <strong>1Password, Bitwarden, LastPass, Proton Pass:</strong> export as CSV. Delete the file
        afterwards: it isn’t encrypted.
      </p>
      {error && <div className="pw-error">{error}</div>}
    </div>
  )
}
