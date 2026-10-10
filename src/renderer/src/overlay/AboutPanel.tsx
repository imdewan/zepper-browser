import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import type { AboutInfo, UpdateStatus } from '@shared/types'
import logo from '../assets/logo.png'
import { zepper } from '../bridge'
import { IconCheck, IconClose, IconCopy, IconSparkle, IconUpdate } from '../icons'
import { isMac } from '../util'

const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** This version's release notes. */
const releaseNotes = (version: string): string => `https://github.com/imdewan/zepper-browser/releases/tag/v${version}`

function widevineLabel(info: AboutInfo): string {
  const { state, version } = info.widevine
  if (state === 'ready') return version ? `On · ${version}` : 'On'
  if (state === 'installing') return 'Installing…'
  if (state === 'restart') return 'Installs on next launch'
  if (state === 'error') return 'Couldn’t install'
  if (state === 'unavailable') return 'Not in this build'
  return version ? `Off · ${version}` : 'Off'
}

/** Where Zepper's update is at (opening About checks, like Chrome), with what you can do about it. */
function UpdateStatusLine({ update }: { update: UpdateStatus }): React.JSX.Element {
  const restart = (): void => zepper.send({ type: 'app.restartToUpdate' })
  const [tone, icon, text, action]: ['good' | 'busy' | 'new' | 'bad' | 'quiet', React.ReactNode, string, React.ReactNode] = (() => {
    switch (update.state) {
      case 'off':
        return ['quiet', null, 'Updates are off in development builds', null]
      case 'idle':
      case 'checking':
        return ['busy', <span key="spin" className="about-spinner" />, 'Checking for updates…', null]
      case 'current':
        return ['good', <IconCheck key="check" size={11} />, 'Zepper is up to date', null]
      case 'downloading':
        return [
          'busy',
          <span key="spin" className="about-spinner" />,
          `Downloading ${update.version} · ${Math.round(update.progress * 100)}%`,
          null
        ]
      case 'ready':
        return [
          'new',
          <IconUpdate key="update" size={11} />,
          `Zepper ${update.version} is ready`,
          <button key="go" className="panel-button primary" onClick={restart}>
            Restart to Update
          </button>
        ]
      case 'manual':
        return [
          'new',
          <IconUpdate key="update" size={11} />,
          `Zepper ${update.version} is out`,
          <button key="go" className="panel-button primary" onClick={restart}>
            Download
          </button>
        ]
      case 'error':
        return [
          'bad',
          null,
          update.message,
          <button key="retry" className="panel-button" onClick={() => zepper.send({ type: 'app.checkForUpdates' })}>
            Try Again
          </button>
        ]
    }
  })()
  return (
    <div className="about-status">
      <span className={`about-pill ${tone}`}>
        {icon && <span className="about-pill-icon">{icon}</span>}
        {text}
      </span>
      {action}
    </div>
  )
}

/** About Zepper: what you're running and what it's built on. */
export function AboutPanel({ info, update, onClose }: { info: AboutInfo; update: UpdateStatus; onClose: () => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rows: [string, string, string?][] = [
    ['Chromium', info.chromium],
    ['Electron', `${info.electron} · castLabs ECS`],
    ['Widevine', widevineLabel(info)],
    [
      'Ad blocking',
      info.filtersUpdatedAt ? `uBlock Origin lists · ${dayFormat.format(info.filtersUpdatedAt)}` : 'uBlock Origin lists',
      info.filtersUpdatedAt ? `Filter lists updated ${dateFormat.format(info.filtersUpdatedAt)}` : undefined
    ],
    ['V8 · Node', `${info.v8} · ${info.node}`]
  ]

  const copy = (): void => {
    const text = [
      `Zepper ${info.version}`,
      ...rows.map(([k, v]) => `${k}: ${v}`),
      isMac
        ? `macOS ${navigator.userAgent.match(/Mac OS X ([\d_]+)/)?.[1]?.replace(/_/g, '.') ?? ''}`
        : `Linux ${navigator.userAgent.match(/Linux ([^;)]+)/)?.[1] ?? ''}`.trim()
    ].join('\n')
    zepper.send({ type: 'clipboard.write', text })
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const whatsNew = (): void => {
    zepper.send({ type: 'tab.open', input: releaseNotes(info.version), where: 'new' })
    onClose()
  }

  return (
    <motion.div
      className="settings-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        className="about"
        initial={{ opacity: 0, scale: 0.95, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.15 } }}
        transition={{ type: 'spring', bounce: 0.15, duration: 0.4 }}
      >
        <button className="about-close" title="Close (Esc)" onClick={onClose}>
          <IconClose size={13} />
        </button>
        <div className="about-hero">
          <img className="about-logo" src={logo} alt="" draggable={false} />
          <h1 className="about-name">Zepper</h1>
          <p className="about-tagline">A private browser with Spaces and built-in ad blocking, on Chromium.</p>
          <div className="about-version">Version {info.version}</div>
          <UpdateStatusLine update={update} />
        </div>
        <dl className="about-rows">
          {rows.map(([label, value, title]) => (
            <div key={label} className="about-row">
              <dt>{label}</dt>
              <dd title={title ?? value}>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="about-actions">
          <button className="panel-button" onClick={copy}>
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
            {copied ? 'Copied' : 'Copy version info'}
          </button>
          <button className="panel-button" onClick={whatsNew}>
            <IconSparkle size={13} />
            What’s new
          </button>
        </div>
        <footer className="about-footer">
          <div>© 2026 Dewan Shakil</div>
          <div>Chromium and Widevine are © Google; filter lists by their authors.</div>
        </footer>
      </motion.div>
    </motion.div>
  )
}
