import { useState } from 'react'
import type { PermissionPrompt, PermissionState, SiteInfo } from '@shared/types'
import { zepper } from '../bridge'
import { IconGlobe, IconLock, IconShield } from '../icons'
import { cx } from '../util'

const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/** The panel behind the lock icon: connection security, certificate, blocking and permissions. */
export function SiteInfoPanel({ info, onClose }: { info: SiteInfo; onClose: () => void }): React.JSX.Element {
  const [permissions, setPermissions] = useState(info.permissions)
  const cert = info.certificate
  const expired = cert ? cert.validTo < Date.now() : false

  const setPermission = (permission: string, state: PermissionState): void => {
    setPermissions((list) => list.map((p) => (p.permission === permission ? { ...p, state } : p)))
    zepper.send({ type: 'site.setPermission', origin: info.origin, permission, state })
  }

  return (
    <div className="site-info">
      <div className="site-header">
        <span className={cx('site-badge', info.secure ? 'secure' : 'insecure')}>
          {info.secure ? <IconLock size={16} /> : <IconGlobe size={16} />}
        </span>
        <div className="site-header-text">
          <div className="site-host">{info.host}</div>
          <div className="site-status">{info.secure ? 'Connection is secure' : 'Connection is not secure'}</div>
        </div>
      </div>
      {info.insecureReason && <p className="site-note">{info.insecureReason}</p>}

      {cert && (
        <section className="site-section">
          <div className="site-section-title">Certificate</div>
          <dl className="cert-grid">
            <dt>Issued to</dt>
            <dd title={cert.subject}>{cert.subject}</dd>
            <dt>Issued by</dt>
            <dd title={cert.issuer}>{cert.issuer}</dd>
            <dt>Valid from</dt>
            <dd>{dateFormat.format(cert.validFrom)}</dd>
            <dt>{expired ? 'Expired' : 'Expires'}</dt>
            <dd className={cx(expired && 'danger')}>{dateFormat.format(cert.validTo)}</dd>
          </dl>
          <button className="panel-button" onClick={() => zepper.send({ type: 'site.showCertificate' })}>
            View Certificate…
          </button>
        </section>
      )}

      <section className="site-section site-row">
        <IconShield size={15} className="site-row-icon" />
        <span className="site-row-label">{info.adblockEnabled ? 'Ads & trackers blocked' : 'Ad blocking is off'}</span>
        {info.adblockEnabled && <span className="site-count">{info.blockedCount}</span>}
      </section>

      {permissions.length > 0 && (
        <section className="site-section">
          <div className="site-section-title">Permissions</div>
          {permissions.map((p) => (
            <div key={p.permission} className="permission-row">
              <span>{p.label}</span>
              <div className="segmented">
                {(['allow', 'ask', 'block'] as const).map((state) => (
                  <button key={state} className={cx(p.state === state && 'selected')} onClick={() => setPermission(p.permission, state)}>
                    {state === 'allow' ? 'Allow' : state === 'ask' ? 'Ask' : 'Block'}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {/^https?:/.test(info.url) && (
        <button
          className="panel-button subtle"
          onClick={() => {
            zepper.send({ type: 'site.clearData', origin: info.origin })
            onClose()
          }}
        >
          Clear Cookies and Site Data
        </button>
      )}
    </div>
  )
}

/** Chrome-style permission request bubble shown under the top-left of the page. */
export function PermissionPanel({ prompt, onDone }: { prompt: PermissionPrompt; onDone: () => void }): React.JSX.Element {
  const respond = (allow: boolean): void => {
    zepper.send({ type: 'permission.respond', id: prompt.id, allow })
    onDone()
  }
  return (
    <div className="permission-prompt">
      <div className="permission-title">
        <strong>{prompt.host}</strong> wants to
      </div>
      <div className="permission-label">{prompt.label}</div>
      <div className="permission-buttons">
        <button className="panel-button" onClick={() => respond(false)}>
          Block
        </button>
        <button className="panel-button primary" onClick={() => respond(true)} autoFocus>
          Allow
        </button>
      </div>
    </div>
  )
}
