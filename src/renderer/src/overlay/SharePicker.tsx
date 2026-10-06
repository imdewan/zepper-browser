import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import type { ShareRequest, ShareSource } from '@shared/types'
import { zepper } from '../bridge'
import { Favicon } from '../Favicon'
import { IconMonitor } from '../icons'
import { cx } from '../util'
import { Toggle } from './Toggle'

type Kind = 'tab' | 'window' | 'screen'

const KINDS: [Kind, string][] = [
  ['tab', 'Tab'],
  ['window', 'Window'],
  ['screen', 'Entire Screen']
]

/**
 * Choosing what to share with a site (getDisplayMedia), like Chrome: one of your tabs, a window, or
 * a whole screen, with its sound when the site asks for audio. A tab shares its own sound; a window
 * or screen shares the Mac's.
 */
export function SharePicker({
  request,
  onDone
}: {
  request: ShareRequest
  onDone: (sourceId: string | null, audio: boolean) => void
}): React.JSX.Element {
  const [kind, setKind] = useState<Kind>(request.tabs.length > 0 ? 'tab' : 'screen')
  const [selected, setSelected] = useState<string | null>(null)
  // Tab sound and the Mac's sound with a whole screen are on to begin with; a window's is off,
  // since it would share every app's sound, not just that window's.
  const [audio, setAudio] = useState<Record<Kind, boolean>>({ tab: true, window: false, screen: true })

  const sources: Record<Kind, ShareSource[]> = { tab: request.tabs, window: request.windows, screen: request.screens }
  const list = sources[kind]
  const canShareAudio = request.audio && (kind === 'tab' || request.systemAudio)
  // With a single screen there's nothing to choose.
  const choice = list.some((s) => s.id === selected) ? selected : kind === 'screen' && list.length === 1 ? list[0].id : null
  const share = (id = choice): void => {
    if (id) onDone(id, canShareAudio && audio[kind])
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDone(null, false)
      else if (e.key === 'Enter' && choice) share()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <motion.div
      className="settings-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      onMouseDown={(e) => e.target === e.currentTarget && onDone(null, false)}
    >
      <motion.div
        className="share"
        role="dialog"
        aria-label={`Choose what to share with ${request.host}`}
        initial={{ opacity: 0, scale: 0.97, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12 } }}
        transition={{ type: 'spring', bounce: 0.12, duration: 0.4 }}
      >
        <header className="share-header">
          <h1>
            Choose what to share with <strong>{request.host}</strong>
          </h1>
          <div className="segmented share-kinds">
            {KINDS.map(([value, label]) => (
              <button key={value} className={cx(kind === value && 'selected')} onClick={() => setKind(value)}>
                {label}
              </button>
            ))}
          </div>
        </header>

        <div className="share-body">
          {kind !== 'tab' && !request.screenAccess && (
            <div className="share-notice">
              <span>
                macOS needs to let Zepper record your screen. Turn on Zepper in Screen &amp; System Audio Recording, then try again.
              </span>
              <button className="panel-button" onClick={() => zepper.send({ type: 'app.openMediaPrivacySettings', kind: 'screen' })}>
                Open Settings
              </button>
            </div>
          )}
          {list.length === 0 ? (
            <p className="share-empty">
              {kind === 'tab' ? 'No other tabs to share.' : kind === 'window' ? 'No windows to share.' : 'No screens to share.'}
            </p>
          ) : kind === 'tab' ? (
            <div className="share-tabs" role="listbox">
              {list.map((tab) => (
                <button
                  key={tab.id}
                  role="option"
                  aria-selected={choice === tab.id}
                  className={cx('share-tab', choice === tab.id && 'selected')}
                  onClick={() => setSelected(tab.id)}
                  onDoubleClick={() => share(tab.id)}
                >
                  <Favicon src={tab.icon} size={16} />
                  <span className="share-tab-title">{tab.name}</span>
                  {tab.detail && <span className="share-tab-host">{tab.detail}</span>}
                </button>
              ))}
            </div>
          ) : (
            <div className={cx('share-grid', kind === 'screen' && 'screens')} role="listbox">
              {list.map((source) => (
                <button
                  key={source.id}
                  role="option"
                  aria-selected={choice === source.id}
                  className={cx('share-card', choice === source.id && 'selected')}
                  onClick={() => setSelected(source.id)}
                  onDoubleClick={() => share(source.id)}
                >
                  <span className="share-thumb">
                    {source.thumbnail ? <img src={source.thumbnail} alt="" draggable={false} /> : <IconMonitor size={28} />}
                  </span>
                  <span className="share-card-label">
                    {source.icon && <img className="share-app-icon" src={source.icon} alt="" draggable={false} />}
                    <span className="share-card-name">{source.name}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <footer className="share-footer">
          {canShareAudio ? (
            <label className="share-audio">
              <Toggle small checked={audio[kind]} onChange={(on) => setAudio((a) => ({ ...a, [kind]: on }))} />
              <span>{kind === 'tab' ? 'Also share tab audio' : 'Also share system audio'}</span>
            </label>
          ) : (
            <span />
          )}
          <div className="share-buttons">
            <button className="ob-secondary" onClick={() => onDone(null, false)}>
              Cancel
            </button>
            <button className="ob-primary" disabled={!choice} onClick={() => share()}>
              Share
            </button>
          </div>
        </footer>
      </motion.div>
    </motion.div>
  )
}
