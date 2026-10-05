import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { CertificateChain, PermissionPrompt, PermissionState, SiteInfo } from '@shared/types'
import { zepper } from '../bridge'
import { IconArrowRight, IconBack, IconCookie, IconGlobe, IconLock, IconShield, IconTrash } from '../icons'
import { cx } from '../util'
import { Toggle } from './Toggle'

const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/** The panel behind the lock icon: connection security, certificate, blocking and permissions. */
export function SiteInfoPanel({ info, onClose }: { info: SiteInfo; onClose: () => void }): React.JSX.Element {
  const [view, setView] = useState<'info' | 'certificate' | 'data'>('info')
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {view === 'info' ? (
        <motion.div
          key="info"
          initial={{ opacity: 0, x: -24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -24 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.28 }}
        >
          <SiteSummary info={info} onShowCertificate={() => setView('certificate')} onShowData={() => setView('data')} />
        </motion.div>
      ) : view === 'data' ? (
        <motion.div
          key="data"
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 24 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.28 }}
        >
          <SiteDataView info={info} onBack={() => setView('info')} onDone={onClose} />
        </motion.div>
      ) : (
        <motion.div
          key="certificate"
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 24 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.28 }}
        >
          {info.chain && <CertificateViewer chain={info.chain} onBack={() => setView('info')} />}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

interface SiteSummaryProps {
  info: SiteInfo
  onShowCertificate: () => void
  onShowData: () => void
}

function SiteSummary({ info, onShowCertificate, onShowData }: SiteSummaryProps): React.JSX.Element {
  const [permissions, setPermissions] = useState(info.permissions)
  const [blocking, setBlocking] = useState(info.adblockSite)
  const web = /^https?:/.test(info.url)
  const cert = info.certificate
  const [openedAt] = useState(() => Date.now())
  const expired = cert ? cert.validTo < openedAt : false

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
          <button className="panel-button" disabled={!info.chain} onClick={onShowCertificate}>
            View Certificate
          </button>
        </section>
      )}

      {web && (
        <section className="site-section site-row">
          <IconShield size={15} className="site-row-icon" />
          <div className="site-row-label">
            <div>Block ads &amp; trackers</div>
            <div className="site-row-sub">
              {!info.adblockEnabled
                ? 'Turned off for all sites in Settings'
                : blocking
                  ? `${info.blockedCount} blocked on this page`
                  : `Off on ${info.siteDomain}`}
            </div>
          </div>
          {info.adblockEnabled && (
            <Toggle
              checked={blocking}
              onChange={(enabled) => {
                setBlocking(enabled)
                zepper.send({ type: 'site.setAdblock', domain: info.siteDomain, enabled })
              }}
            />
          )}
        </section>
      )}

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
        <button className="site-section site-row site-link" onClick={onShowData}>
          <IconCookie size={15} className="site-row-icon" />
          <span className="site-row-label">Cookies and site data</span>
          <span className="site-row-value">
            {info.siteData.length === 0 ? 'None' : `${info.siteData.length} ${info.siteData.length === 1 ? 'site' : 'sites'}`}
          </span>
          <IconArrowRight size={13} className="site-row-chevron" />
        </button>
      )}
    </div>
  )
}

/** "On-device site data": which domains under this site store data here, with per-domain delete. */
function SiteDataView({ info, onBack, onDone }: { info: SiteInfo; onBack: () => void; onDone: () => void }): React.JSX.Element {
  const [entries, setEntries] = useState(info.siteData)
  const remove = (domain: string): void => {
    zepper.send({ type: 'site.clearDomain', domain })
    setEntries((list) => list.filter((e) => e.domain !== domain))
  }
  return (
    <div className="site-data">
      <div className="cert-header">
        <button className="cert-back" onClick={onBack} title="Back">
          <IconBack size={15} />
        </button>
        <div className="cert-header-title">On-device site data</div>
      </div>
      <p className="site-note">
        Sites save things like your sign-in, preferences and shopping cart to this device. Deleting a site’s data signs you out of it.
      </p>
      <div className="site-section-title">Data from the site you’re visiting</div>
      <div className="site-data-list">
        <AnimatePresence initial={false}>
          {entries.map((entry) => (
            <motion.div
              key={entry.domain}
              className="site-data-row"
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, height: 0, transition: { duration: 0.18 } }}
            >
              <IconGlobe size={16} className="site-data-icon" />
              <div className="site-data-text">
                <div className="site-data-domain">{entry.domain}</div>
                <div className="site-data-count">
                  {entry.cookies} {entry.cookies === 1 ? 'cookie' : 'cookies'}
                </div>
              </div>
              <button className="site-data-delete" title={`Delete data from ${entry.domain}`} onClick={() => remove(entry.domain)}>
                <IconTrash size={14} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
        {entries.length === 0 && <div className="site-data-empty">No data stored for this site.</div>}
      </div>
      <div className="site-data-footer">
        <button
          className="panel-button subtle"
          disabled={entries.length === 0}
          onClick={() => {
            for (const entry of entries) zepper.send({ type: 'site.clearDomain', domain: entry.domain })
            zepper.send({ type: 'site.clearData', origin: info.origin })
            setEntries([])
          }}
        >
          Delete All
        </button>
        <button className="panel-button primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  )
}

const longDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' })

/** In-app certificate viewer: the chain from root to leaf, and the selected certificate's fields. */
function CertificateViewer({ chain, onBack }: { chain: CertificateChain; onBack: () => void }): React.JSX.Element {
  const [selected, setSelected] = useState(0)
  const [copied, setCopied] = useState<string | null>(null)
  const entry = chain.entries[selected]
  const [now] = useState(() => Date.now())
  const valid = entry.validFrom <= now && now <= entry.validTo
  // Display the hierarchy root-first, like Keychain Access and Chrome.
  const hierarchy = chain.entries.map((e, i) => ({ e, i })).reverse()

  const copy = (label: string, text: string): void => {
    zepper.send({ type: 'clipboard.write', text })
    setCopied(label)
    window.setTimeout(() => setCopied((c) => (c === label ? null : c)), 1200)
  }

  return (
    <div className="cert-viewer">
      <div className="cert-header">
        <button className="cert-back" onClick={onBack} title="Back">
          <IconBack size={15} />
        </button>
        <div className="cert-header-title">Certificate</div>
        <span className={cx('cert-trust', chain.trusted ? 'ok' : 'bad')}>{chain.trusted ? 'Trusted' : 'Not trusted'}</span>
      </div>

      <div className="cert-chain">
        {hierarchy.map(({ e, i }, depth) => (
          <button
            key={i}
            className={cx('cert-chain-item', i === selected && 'selected')}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => setSelected(i)}
          >
            <span className="cert-chain-icon">{e.isCA ? '🏛' : '📄'}</span>
            <span className="cert-chain-name">{e.commonName}</span>
          </button>
        ))}
      </div>

      <div className="cert-scroll">
        <div className="cert-hero">
          <div className="cert-hero-name">{entry.commonName}</div>
          <div className="cert-hero-sub">
            {entry.isCA ? 'Certificate authority' : 'Server certificate'} · issued by{' '}
            {entry.issuer.find((f) => f.label === 'Common Name')?.value ?? 'unknown'}
          </div>
          <span className={cx('cert-validity', valid ? 'ok' : 'bad')}>
            {valid ? '✓ Valid' : now < entry.validFrom ? 'Not yet valid' : 'Expired'}
          </span>
        </div>

        <CertSection title="Issued to" fields={entry.subject} />
        <CertSection title="Issued by" fields={entry.issuer} />
        <CertSection
          title="Validity"
          fields={[
            { label: 'Issued on', value: longDate.format(entry.validFrom) },
            { label: 'Expires on', value: longDate.format(entry.validTo) }
          ]}
        />
        <div className="cert-section">
          <div className="cert-section-title">Fingerprints</div>
          {[
            ['SHA-256', entry.sha256],
            ['SHA-1', entry.sha1]
          ]
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <button key={label} className="cert-fingerprint" onClick={() => copy(label, value)} title="Copy">
                <span className="cert-field-label">{label}</span>
                <code>{value}</code>
                <span className="cert-copy">{copied === label ? 'Copied' : 'Copy'}</span>
              </button>
            ))}
        </div>
        <CertSection
          title="Details"
          fields={[
            { label: 'Serial number', value: entry.serialNumber },
            ...(entry.publicKey ? [{ label: 'Public key', value: entry.publicKey }] : []),
            ...(entry.signatureAlgorithm ? [{ label: 'Signature', value: entry.signatureAlgorithm }] : [])
          ]}
          mono
        />
        {entry.altNames.length > 0 && (
          <div className="cert-section">
            <div className="cert-section-title">Also valid for ({entry.altNames.length})</div>
            <div className="cert-alt-names">
              {entry.altNames.slice(0, 40).map((name) => (
                <span key={name} className="cert-alt-name">
                  {name}
                </span>
              ))}
              {entry.altNames.length > 40 && <span className="cert-alt-name more">+{entry.altNames.length - 40} more</span>}
            </div>
          </div>
        )}
      </div>

      <div className="cert-footer">
        <button className="panel-button" onClick={() => zepper.send({ type: 'site.exportCertificate', index: selected })}>
          Export…
        </button>
      </div>
    </div>
  )
}

function CertSection({
  title,
  fields,
  mono
}: {
  title: string
  fields: { label: string; value: string }[]
  mono?: boolean
}): React.JSX.Element | null {
  if (fields.length === 0) return null
  return (
    <div className="cert-section">
      <div className="cert-section-title">{title}</div>
      <dl className={cx('cert-fields', mono && 'mono')}>
        {fields.map((f) => (
          <div key={f.label} className="cert-field">
            <dt className="cert-field-label">{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** Chrome-style permission request bubble shown under the top-left of the page. */
/** Brave-style offer to turn on Google Widevine when a site needs it for protected video. */
export function WidevinePrompt({ host, restart, onDone }: { host: string; restart: boolean; onDone: () => void }): React.JSX.Element {
  const respond = (choice: 'install' | 'later' | 'never'): void => {
    zepper.send({ type: 'widevine.respond', host, choice })
    onDone()
  }
  return (
    <div className="permission-prompt widevine-prompt">
      <div className="permission-title">
        <strong>{host}</strong> wants to
      </div>
      <div className="permission-label">Play protected content</div>
      <p className="widevine-text">
        This needs Google Widevine, a small component from Google that protected video like Netflix and Crunchyroll relies on.
        {restart && ' Zepper restarts once to finish installing it; your tabs come back.'}
      </p>
      <div className="widevine-actions">
        <button className="widevine-never" onClick={() => respond('never')}>
          Don’t ask again
        </button>
        <button className="panel-button" onClick={() => respond('later')}>
          Not now
        </button>
        <button className="panel-button primary" onClick={() => respond('install')}>
          {restart ? 'Install and restart' : 'Install'}
        </button>
      </div>
    </div>
  )
}

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
