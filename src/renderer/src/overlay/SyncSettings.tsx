import { useMemo, useState } from 'react'
import qrcode from 'qrcode-generator'
import type { SyncSnapshot } from '@shared/types'
import { zepper } from '../bridge'

/**
 * Settings › Sync: Zepper for iPhone (and your other computers) with the same spaces, Essentials and
 * pinned tabs. The phone scans the code shown here; no account, and everything is encrypted with
 * the code before it leaves the device.
 */
export function SyncSettings({ sync }: { sync: SyncSnapshot }): React.JSX.Element {
  const [typing, setTyping] = useState(false)
  const [code, setCode] = useState('')
  const { status } = sync

  if (status.kind === 'unavailable') {
    return (
      <Row
        label="Sync isn’t set up in this build"
        hint="It needs the Firebase project’s settings in src/main/sync-config.json (see the iPhone app’s firebase/README.md)."
      />
    )
  }

  if (status.kind === 'off') {
    return (
      <>
        <Row
          label="Sync with Zepper for iPhone"
          hint="Your spaces, Essentials and pinned tabs, the same on your phone, and each other’s open tabs. Encrypted on your devices: no one else can read them."
        >
          <button className="panel-button primary" onClick={() => zepper.send({ type: 'sync.start' })}>
            Sync with Phone
          </button>
        </Row>
        <Row label="Have a sync code?" hint="From Zepper on another device (Settings › Sync).">
          {!typing && (
            <button className="panel-button" onClick={() => setTyping(true)}>
              Enter Code…
            </button>
          )}
        </Row>
        {typing && (
          <div className="settings-row settings-row-stacked">
            <input
              className="settings-input sync-code-input"
              autoFocus
              value={code}
              placeholder="XXXX-XXXX-XXXX-…"
              spellCheck={false}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && code.trim()) zepper.send({ type: 'sync.join', code })
                if (e.key === 'Escape') setTyping(false)
              }}
            />
            <div className="sync-actions">
              <button className="panel-button" onClick={() => setTyping(false)}>
                Cancel
              </button>
              <button className="panel-button primary" onClick={() => code.trim() && zepper.send({ type: 'sync.join', code })}>
                Join
              </button>
            </div>
          </div>
        )}
      </>
    )
  }

  return (
    <>
      {sync.code && <CodeCard code={sync.code} />}
      <Row
        label={
          status.kind === 'on'
            ? status.devices === 0
              ? 'Waiting for your phone'
              : `Synced with ${status.devices} other device${status.devices === 1 ? '' : 's'}`
            : status.kind === 'connecting'
              ? 'Connecting…'
              : 'Sync stopped'
        }
        hint={status.kind === 'error' ? status.message : 'Each device keeps its own sign-ins and history.'}
      >
        {!sync.code && (
          <button className="panel-button" onClick={() => zepper.send({ type: 'sync.showCode', show: true })}>
            Add a Device…
          </button>
        )}
      </Row>
      {sync.devices.map((device) => (
        <Row
          key={device.id}
          label={device.name}
          hint={`${platformName(device.platform)} · ${device.tabs.length} open tab${device.tabs.length === 1 ? '' : 's'} · ${ago(device.seenAt)}`}
        />
      ))}
      <ComputerName name={sync.deviceName} />
      <Row label="Stop syncing on this computer" hint="It keeps its spaces and tabs; your other devices stop seeing it.">
        <button className="panel-button danger" onClick={() => zepper.send({ type: 'sync.leave' })}>
          Stop Syncing
        </button>
      </Row>
    </>
  )
}

/** The sync code as a QR code, for the iPhone's Camera app (which opens it in Zepper). */
export function SyncQr({ code, className = 'sync-qr' }: { code: string; className?: string }): React.JSX.Element {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(`zepper://sync#${code.replace(/-/g, '')}`)
    qr.make()
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
  }, [code])
  return <div className={className} dangerouslySetInnerHTML={{ __html: svg }} />
}

function CodeCard({ code }: { code: string }): React.JSX.Element {
  return (
    <div className="sync-code">
      <SyncQr code={code} />
      <div className="sync-code-text">
        <div className="settings-row-label">Scan this with your iPhone</div>
        <div className="settings-row-hint">
          With the Camera app, or in Zepper › Settings › Sync. On another computer, type the code instead:
        </div>
        <code className="sync-code-value">
          {/* Breaks only between groups of four. */}
          {code.split('-').map((group, i) => (
            <span key={i}>
              {i > 0 && '-'}
              {i > 0 && <wbr />}
              {group}
            </span>
          ))}
        </code>
        <div className="settings-row-hint">Anyone with this code can see your synced spaces: keep it to yourself.</div>
        <button className="panel-button" onClick={() => zepper.send({ type: 'sync.showCode', show: false })}>
          Done
        </button>
      </div>
    </div>
  )
}

function ComputerName({ name }: { name: string }): React.JSX.Element {
  const [draft, setDraft] = useState(name)
  const commit = (): void => {
    if (draft.trim() && draft.trim() !== name) zepper.send({ type: 'sync.rename', name: draft.trim() })
  }
  return (
    <Row label="This computer’s name" hint="What your other devices call it.">
      <input
        className="settings-input sync-name-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    </Row>
  )
}

function platformName(platform: SyncSnapshot['devices'][number]['platform']): string {
  return platform === 'ios' ? 'iPhone' : platform === 'mac' ? 'Mac' : platform === 'windows' ? 'Windows' : 'Linux'
}

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 2) return 'active now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}

function Row({ label, hint, children }: { label: string; hint?: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        {hint && <div className="settings-row-hint">{hint}</div>}
      </div>
      {children && <div className="settings-row-control">{children}</div>}
    </div>
  )
}
