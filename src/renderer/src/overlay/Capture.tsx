import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { Rect } from '@shared/types'
import { zepper } from '../bridge'
import { IconClose } from '../icons'
import { cx } from '../util'

export interface CaptureSession {
  page: Rect
  targets: Rect[]
  scrolls: boolean
}

const contains = (r: Rect, x: number, y: number): boolean => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height

/** The element under the pointer worth capturing: the smallest one that's at least 100×30, like Firefox's. */
function snap(session: CaptureSession, x: number, y: number): (Rect & { full: Rect }) | null {
  const { page } = session
  const visibleArea = (r: Rect): number =>
    Math.max(0, Math.min(r.x + r.width, page.x + page.width) - Math.max(r.x, page.x)) *
    Math.max(0, Math.min(r.y + r.height, page.y + page.height) - Math.max(r.y, page.y))
  let best: Rect | null = null
  for (const target of session.targets) {
    if (!contains(target, x, y) || target.width < 100 || target.height < 30) continue
    // Something filling the whole screen (the page's own wrapper) isn't a useful element.
    if (visibleArea(target) > page.width * page.height * 0.92) continue
    if (!best || target.width * target.height < best.width * best.height) best = target
  }
  // Clipped to the page area.
  if (!best) return null
  const left = Math.max(best.x, page.x)
  const top = Math.max(best.y, page.y)
  const right = Math.min(best.x + best.width, page.x + page.width)
  const bottom = Math.min(best.y + best.height, page.y + page.height)
  return { x: left, y: top, width: right - left, height: bottom - top, full: best }
}

/**
 * Capture mode (⇧⌘2): the page dims; hovering highlights an element to capture with a click,
 * dragging selects a region. Visible and Full page capture the whole screen or the whole page.
 */
export function CaptureOverlay({ session, onDone }: { session: CaptureSession; onDone: () => void }): React.JSX.Element {
  const [hover, setHover] = useState<(Rect & { full?: Rect }) | null>(null)
  const [drag, setDrag] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const { page } = session

  const take = (mode: 'visible' | 'full' | 'area', rect?: Rect): void => {
    zepper.send({ type: 'capture.take', mode, rect })
    onDone()
  }
  const cancel = (): void => {
    zepper.send({ type: 'capture.cancel' })
    onDone()
  }

  useEffect(() => {
    root.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel()
      else if (e.key === 'Enter' || e.key.toLowerCase() === 'v') take('visible')
      else if (e.key.toLowerCase() === 'f' && session.scrolls) take('full')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const clamp = (x: number, y: number): [number, number] => [
    Math.min(Math.max(x, page.x), page.x + page.width),
    Math.min(Math.max(y, page.y), page.y + page.height)
  ]
  const region = drag
    ? {
        x: Math.min(drag.x, drag.x2),
        y: Math.min(drag.y, drag.y2),
        width: Math.abs(drag.x2 - drag.x),
        height: Math.abs(drag.y2 - drag.y)
      }
    : null
  const dragging = region !== null && (region.width > 6 || region.height > 6)
  const spot = dragging ? region : hover

  return (
    <motion.div
      ref={root}
      tabIndex={-1}
      className="capture"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.1 } }}
      onMouseMove={(e) => {
        if (drag) {
          const [x2, y2] = clamp(e.clientX, e.clientY)
          setDrag({ ...drag, x2, y2 })
        } else setHover(contains(page, e.clientX, e.clientY) ? snap(session, e.clientX, e.clientY) : null)
      }}
      onMouseDown={(e) => {
        if (e.button !== 0 || !contains(page, e.clientX, e.clientY)) return
        setDrag({ x: e.clientX, y: e.clientY, x2: e.clientX, y2: e.clientY })
      }}
      onMouseUp={() => {
        if (dragging && region) take('area', region)
        else if (drag && hover) take('area', hover.full ?? hover)
        setDrag(null)
      }}
    >
      {/* The page dims around what you're about to capture. */}
      <div className="capture-page" style={{ left: page.x, top: page.y, width: page.width, height: page.height }}>
        {spot ? (
          <div
            className={cx('capture-spot', dragging && 'dragging')}
            style={{ left: spot.x - page.x, top: spot.y - page.y, width: spot.width, height: spot.height }}
          >
            <span className="capture-size">
              {Math.round(spot.width)} × {Math.round(spot.height)}
            </span>
          </div>
        ) : (
          <div className="capture-dim" />
        )}
      </div>
      <div className="capture-toolbar" style={{ left: page.x + page.width / 2, top: page.y + 14 }} onMouseDown={(e) => e.stopPropagation()}>
        <span className="capture-hint">Click an element or drag a region</span>
        <button onClick={() => take('visible')}>
          Visible <kbd>V</kbd>
        </button>
        {session.scrolls && (
          <button onClick={() => take('full')}>
            Full page <kbd>F</kbd>
          </button>
        )}
        <button className="capture-cancel" title="Cancel (Esc)" onClick={cancel}>
          <IconClose size={12} />
        </button>
      </div>
    </motion.div>
  )
}

export interface CaptureResultInfo {
  thumbnail: string
  width: number
  height: number
  saved: string | null
}

/** After a capture: it's on the clipboard; save it, show it, retake, or drag it out to another app. */
export function CaptureResult({ result, onDismiss }: { result: CaptureResultInfo; onDismiss: () => void }): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  useEffect(() => {
    if (hovered) return
    const timer = setTimeout(() => {
      zepper.send({ type: 'capture.dismiss' })
      onDismiss()
    }, 10_000)
    return () => clearTimeout(timer)
  }, [hovered, onDismiss])
  return (
    <motion.div
      className="capture-result"
      initial={{ opacity: 0, y: -8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <img
        className="capture-thumb"
        src={result.thumbnail}
        alt="Capture"
        draggable
        title="Drag into another app"
        onDragStart={(e) => {
          e.preventDefault()
          zepper.send({ type: 'capture.drag' })
        }}
      />
      <div className="capture-result-body">
        <div className="capture-result-title">{result.saved ? 'Saved to Downloads' : 'Copied to clipboard'}</div>
        <div className="capture-result-size">
          {result.width} × {result.height}
        </div>
        <div className="capture-result-actions">
          {result.saved ? (
            <button onClick={() => zepper.send({ type: 'capture.reveal' })}>Show in Finder</button>
          ) : (
            <button onClick={() => zepper.send({ type: 'capture.save' })}>Save</button>
          )}
          <button
            onClick={() => {
              onDismiss()
              zepper.send({ type: 'capture.retake' })
            }}
          >
            Retake
          </button>
        </div>
      </div>
      <button
        className="capture-result-close"
        title="Dismiss"
        onClick={() => {
          zepper.send({ type: 'capture.dismiss' })
          onDismiss()
        }}
      >
        <IconClose size={10} />
      </button>
    </motion.div>
  )
}
