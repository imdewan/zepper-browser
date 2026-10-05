import { useEffect, useRef, useState } from 'react'
import { zepper } from '../bridge'
import { IconClose, IconMuted, IconPause, IconPlay, IconPopIn, IconSkipBack, IconSkipForward, IconSpeaker } from '../icons'
import { useSnapshot } from '../useSnapshot'
import { cx } from '../util'

const HIDE_AFTER_MS = 1800

/**
 * Hover controls over the floating video: back to tab, skip ±10s, play/pause,
 * mute, close. Keys: ←/→ skip, Space play/pause, M mute.
 */
export function PipControls(): React.JSX.Element {
  const tabId = new URLSearchParams(location.search).get('tab') ?? ''
  const snapshot = useSnapshot()
  const tab = snapshot?.tabs.find((t) => t.id === tabId)
  const [visible, setVisible] = useState(true)
  const [skipped, setSkipped] = useState<{ seconds: number; at: number } | null>(null)
  const timer = useRef(0)
  const skipTimer = useRef(0)

  const reveal = (): void => {
    setVisible(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setVisible(false), HIDE_AFTER_MS)
  }
  useEffect(() => {
    reveal()
    return () => window.clearTimeout(timer.current)
  }, [])

  const skip = (seconds: number): void => {
    zepper.send({ type: 'media.seek', tabId, seconds })
    setSkipped({ seconds, at: Date.now() })
    window.clearTimeout(skipTimer.current)
    skipTimer.current = window.setTimeout(() => setSkipped(null), 650)
    reveal()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') skip(-10)
      else if (e.key === 'ArrowRight') skip(10)
      else if (e.key === ' ' || e.key === 'k') zepper.send({ type: 'media.toggle', tabId })
      else if (e.key === 'm') zepper.send({ type: 'tab.toggleMute', tabId })
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const playing = !!tab?.audible
  const title = tab?.media?.title || tab?.title || ''

  return (
    <div
      className={cx('pip', visible && 'show')}
      data-ui="dark"
      onMouseMove={reveal}
      onMouseEnter={reveal}
      onMouseLeave={() => setVisible(false)}
      onClick={(e) => {
        if (e.target === e.currentTarget) zepper.send({ type: 'media.toggle', tabId })
      }}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) zepper.send({ type: 'pip.back' })
      }}
    >
      <div className="pip-drag" />
      <div className="pip-shade top" />
      <div className="pip-shade bottom" />
      <button className="pip-button back" title="Back to tab" onClick={() => zepper.send({ type: 'pip.back' })}>
        <IconPopIn size={16} />
      </button>
      <button className="pip-button close" title="Close" onClick={() => zepper.send({ type: 'pip.close' })}>
        <IconClose size={14} />
      </button>
      <div className="pip-center">
        <button className="pip-skip" title="Back 10 seconds (←)" onClick={() => skip(-10)}>
          <IconSkipBack size={22} />
        </button>
        <button className="pip-play" title={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => zepper.send({ type: 'media.toggle', tabId })}>
          {playing ? <IconPause size={26} /> : <IconPlay size={26} />}
        </button>
        <button className="pip-skip" title="Forward 10 seconds (→)" onClick={() => skip(10)}>
          <IconSkipForward size={22} />
        </button>
      </div>
      {skipped && (
        <div key={skipped.at} className={cx('pip-skipped', skipped.seconds < 0 ? 'back' : 'forward')}>
          {skipped.seconds < 0 ? '−10s' : '+10s'}
        </div>
      )}
      <div className="pip-bottom">
        <span className="pip-title">{title}</span>
        <button className="pip-button" title={tab?.muted ? 'Unmute' : 'Mute'} onClick={() => zepper.send({ type: 'tab.toggleMute', tabId })}>
          {tab?.muted ? <IconMuted size={15} /> : <IconSpeaker size={15} />}
        </button>
      </div>
    </div>
  )
}
