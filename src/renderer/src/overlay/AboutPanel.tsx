import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import type { AboutInfo } from '@shared/types'
import logo from '../assets/logo.png'
import { zepper } from '../bridge'
import { IconCheck, IconClose, IconCopy } from '../icons'

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function widevineLabel(info: AboutInfo): string {
  const { state, version } = info.widevine
  if (state === 'ready') return version ? `${version} · on` : 'On'
  if (state === 'installing') return 'Installing…'
  if (state === 'restart') return 'Installs on next launch'
  if (state === 'error') return 'Couldn’t install'
  if (state === 'unavailable') return 'Not in this build'
  return version ? `${version} · off` : 'Off'
}

/** About Zepper: what you're running and what it's built on. */
export function AboutPanel({ info, onClose }: { info: AboutInfo; onClose: () => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rows: [string, string][] = [
    ['Chromium', info.chromium],
    ['Electron', `${info.electron} (castLabs ECS)`],
    ['Widevine', widevineLabel(info)],
    [
      'Ad blocking',
      info.filtersUpdatedAt ? `uBlock Origin lists · updated ${dateFormat.format(info.filtersUpdatedAt)}` : 'uBlock Origin lists'
    ],
    ['V8 · Node', `${info.v8} · ${info.node}`]
  ]

  const copy = (): void => {
    const text = [
      `Zepper ${info.version}`,
      ...rows.map(([k, v]) => `${k}: ${v}`),
      `macOS ${navigator.userAgent.match(/Mac OS X ([\d_]+)/)?.[1]?.replace(/_/g, '.') ?? ''}`
    ].join('\n')
    zepper.send({ type: 'clipboard.write', text })
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
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
        <button className="settings-close" title="Close (Esc)" onClick={onClose}>
          <IconClose size={14} />
        </button>
        <img className="about-logo" src={logo} alt="" draggable={false} />
        <h1 className="about-name">Zepper</h1>
        <div className="about-version">Version {info.version}</div>
        <p className="about-tagline">A calm browser with Spaces and built-in ad blocking, on Chromium.</p>
        <dl className="about-rows">
          {rows.map(([label, value]) => (
            <div key={label} className="about-row">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <button className="panel-button about-copy" onClick={copy}>
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          {copied ? 'Copied' : 'Copy version info'}
        </button>
        <div className="about-footer">© 2026 Dewan Shakil · Chromium and Widevine are © Google; filter lists by their authors.</div>
      </motion.div>
    </motion.div>
  )
}
