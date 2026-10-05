import { useEffect, useRef, useState } from 'react'
import { zepper } from '../bridge'
import { IconClose, IconMuted, IconPause, IconPlay, IconPopIn, IconSpeaker } from '../icons'
import { useSnapshot } from '../useSnapshot'
import { cx } from '../util'

const HIDE_AFTER_MS = 1800

/** Hover controls over the floating video: back to tab, play/pause, mute, close. */
export function PipControls(): React.JSX.Element {
  const tabId = new URLSearchParams(location.search).get('tab') ?? ''
  const snapshot = useSnapshot()
  const tab = snapshot?.tabs.find((t) => t.id === tabId)
  const [visible, setVisible] = useState(true)
  const timer = useRef(0)

  const reveal = (): void => {
    setVisible(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setVisible(false), HIDE_AFTER_MS)
  }
  useEffect(() => {
    reveal()
    return () => window.clearTimeout(timer.current)
  }, [])

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
      <button className="pip-play" title={playing ? 'Pause' : 'Play'} onClick={() => zepper.send({ type: 'media.toggle', tabId })}>
        {playing ? <IconPause size={26} /> : <IconPlay size={26} />}
      </button>
      <div className="pip-bottom">
        <span className="pip-title">{title}</span>
        <button className="pip-button" title={tab?.muted ? 'Unmute' : 'Mute'} onClick={() => zepper.send({ type: 'tab.toggleMute', tabId })}>
          {tab?.muted ? <IconMuted size={15} /> : <IconSpeaker size={15} />}
        </button>
      </div>
    </div>
  )
}
