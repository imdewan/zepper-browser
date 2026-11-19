import { useEffect, useRef, useState } from 'react'
import { SkipBack, SkipForward } from 'lucide-react'
import type { PipState } from '@shared/types'
import { zepper } from '../bridge'
import { Favicon } from '../Favicon'
import { IconClose, IconMuted, IconPause, IconPlay, IconPopIn, IconSkipBack, IconSkipForward, IconSpeaker } from '../icons'
import { useSnapshot } from '../useSnapshot'
import { cx } from '../util'

/** The controls hide this long after the pointer stops moving over the player, as in Chromium's. */
const HIDE_AFTER_MS = 2500
/** When it opens, the site's name shows for this long. */
const TITLE_MS = 2500

/** 1:05, or 1:02:05. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`
}

function siteOf(url: string | undefined): string {
  try {
    return new URL(url ?? '').hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * The floating video's controls, laid out as Chromium's player: the site at the top left, back to tab
 * and close at the top right; back 10 seconds, play/pause and forward 10 in the middle; the time, mute,
 * and a progress bar you can drag at the bottom, with the page's previous and next (Shorts, a playlist)
 * beside it. They show while the pointer is over the player. Keys: Space play/pause, ←/→ 10 seconds,
 * M mute. The rest of the player moves it (only the button plays and pauses).
 */
export function PipControls(): React.JSX.Element {
  const tabId = new URLSearchParams(location.search).get('tab') ?? ''
  const snapshot = useSnapshot()
  const tab = snapshot?.tabs.find((t) => t.id === tabId)
  const [visible, setVisible] = useState(false)
  const [titleShown, setTitleShown] = useState(true)
  const [state, setState] = useState<(PipState & { at: number }) | null>(null)
  /** Where the progress bar is being dragged to, in seconds. */
  const [scrub, setScrub] = useState<number | null>(null)
  const [, setFrame] = useState(0)
  const hideTimer = useRef(0)
  /** The main process saw the pointer move over the player, or leave it (see watchPointer in main/pip.ts). */
  const pointer = useRef<(inside: boolean) => void>(() => {})
  const scrubbing = useRef(false)

  useEffect(
    () =>
      zepper.onEvent((event) => {
        if (event.type === 'pip.state') setState({ ...event.state, at: performance.now() })
        else if (event.type === 'pip.pointer') pointer.current(event.inside)
      }),
    []
  )
  useEffect(() => {
    const timer = window.setTimeout(() => setTitleShown(false), TITLE_MS)
    return () => window.clearTimeout(timer)
  }, [])

  const reveal = (): void => {
    setVisible(true)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => !scrubbing.current && setVisible(false), HIDE_AFTER_MS)
  }
  const hide = (): void => {
    if (scrubbing.current) return
    window.clearTimeout(hideTimer.current)
    setVisible(false)
  }
  pointer.current = (inside) => (inside ? reveal() : hide())

  const playing = state ? !state.paused : !!tab?.audible
  const live = state !== null && state.duration === null
  // Between updates the time runs on by itself, so the bar moves smoothly while you watch.
  useEffect(() => {
    if (!visible || !playing || live) return
    let frame = requestAnimationFrame(function tick() {
      setFrame((n) => n + 1)
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [visible, playing, live])
  const duration = state?.duration ?? 0
  const time = scrub ?? (state ? Math.min(duration || Infinity, state.time + (playing ? (performance.now() - state.at) / 1000 : 0)) : 0)

  const toggle = (): void => zepper.send({ type: 'media.toggle', tabId })
  const skip = (seconds: number): void => zepper.send({ type: 'media.seek', tabId, seconds })
  const mute = (): void => zepper.send({ type: 'tab.toggleMute', tabId })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      reveal()
      if (e.key === 'ArrowLeft') skip(-10)
      else if (e.key === 'ArrowRight') skip(10)
      else if (e.key === ' ' || e.key === 'k') toggle()
      else if (e.key === 'm') mute()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const seekAt = (e: React.PointerEvent<HTMLDivElement>): number => {
    const box = e.currentTarget.getBoundingClientRect()
    return Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) * duration
  }
  const progress = duration ? Math.min(1, time / duration) : 0

  return (
    <div
      className={cx('pip', visible && 'show', (visible || titleShown) && 'show-top')}
      data-ui="dark"
      onMouseMove={reveal}
      onMouseEnter={reveal}
    >
      <div className="pip-scrim" />
      <div className="pip-shade top" />
      <div className="pip-shade bottom" />

      <div className="pip-top">
        <Favicon src={tab?.favicon ?? null} size={16} className="pip-favicon" />
        <span className="pip-site">{siteOf(tab?.url)}</span>
        <button className="pip-icon" title="Back to tab" aria-label="Back to tab" onClick={() => zepper.send({ type: 'pip.back' })}>
          <IconPopIn size={16} />
        </button>
        <button
          className="pip-icon"
          title="Close (keeps playing in its tab)"
          aria-label="Close"
          onClick={() => zepper.send({ type: 'pip.close' })}
        >
          <IconClose size={14} />
        </button>
      </div>

      <div className="pip-center">
        {!live && (
          <button className="pip-seek" title="Back 10 seconds (←)" aria-label="Back 10 seconds" onClick={() => skip(-10)}>
            <IconSkipBack size={24} />
          </button>
        )}
        <button
          className="pip-play"
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={toggle}
        >
          {playing ? <IconPause size={30} /> : <IconPlay size={30} />}
        </button>
        {!live && (
          <button className="pip-seek" title="Forward 10 seconds (→)" aria-label="Forward 10 seconds" onClick={() => skip(10)}>
            <IconSkipForward size={24} />
          </button>
        )}
      </div>

      <div className="pip-bottom">
        <div className="pip-row">
          {live ? (
            <span className="pip-live">LIVE</span>
          ) : (
            <span className="pip-time">{state && duration ? `${clock(time)} / ${clock(duration)}` : ''}</span>
          )}
          <button
            className="pip-icon"
            title={tab?.muted ? 'Unmute (M)' : 'Mute (M)'}
            aria-label={tab?.muted ? 'Unmute' : 'Mute'}
            onClick={mute}
          >
            {tab?.muted ? <IconMuted size={15} /> : <IconSpeaker size={15} />}
          </button>
        </div>
        <div className="pip-row">
          {state?.previous && (
            <button
              className="pip-icon"
              title="Previous"
              aria-label="Previous"
              onClick={() => zepper.send({ type: 'pip.track', action: 'previoustrack' })}
            >
              <SkipBack size={14} fill="currentColor" />
            </button>
          )}
          {!live && duration > 0 ? (
            <div
              className={cx('pip-progress', scrub !== null && 'scrubbing')}
              role="slider"
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(time)}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                scrubbing.current = true
                setScrub(seekAt(e))
              }}
              onPointerMove={(e) => scrubbing.current && setScrub(seekAt(e))}
              onPointerUp={(e) => {
                if (!scrubbing.current) return
                scrubbing.current = false
                const to = seekAt(e)
                zepper.send({ type: 'pip.seekTo', time: to })
                setState((s) => (s ? { ...s, time: to, at: performance.now() } : s))
                setScrub(null)
                reveal()
              }}
              onPointerCancel={() => {
                scrubbing.current = false
                setScrub(null)
              }}
            >
              <div className="pip-track">
                <div className="pip-fill" style={{ width: `${progress * 100}%` }} />
              </div>
              <div className="pip-knob" style={{ left: `${progress * 100}%` }} />
            </div>
          ) : (
            <div className="pip-progress-space" />
          )}
          {state?.next && (
            <button
              className="pip-icon"
              title="Next"
              aria-label="Next"
              onClick={() => zepper.send({ type: 'pip.track', action: 'nexttrack' })}
            >
              <SkipForward size={14} fill="currentColor" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
