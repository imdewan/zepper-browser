import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { Columns2, Maximize2, X } from 'lucide-react'
import type { Rect } from '@shared/types'
import { acceleratorLabel } from '@shared/shortcuts'
import { zepper } from '../bridge'
import { isMac } from '../util'

export interface QuickViewRequest {
  id: number
  /** Where the link is, in the window: the card grows from it and shrinks back to it. */
  origin: Rect | null
  /**
   * 'closing': main sent a picture of the page (`image`) for the card to shrink back with, and takes
   * the page away once the card shows it. 'expanding': the page is growing into a tab over the card.
   */
  phase: 'open' | 'closing' | 'expanding'
  image?: string | null
}

/** Room each side of the card within the page area (the buttons sit in the left one), as a share of it, between these. */
const MARGIN = { share: 0.065, min: 56, max: 96 }
/** The round buttons beside the card, and their gaps. */
const BUTTON = 30
const BUTTON_GAP = 10
const SIDE_GAP = 12
/** The card's corners, which are its page's (QUICK_VIEW_RADIUS). */
const RADIUS = 12
/** Opens it as a tab (main hears it in the page). */
const EXPAND_KEYS = acceleratorLabel('CmdOrCtrl+Shift+Return', isMac ? 'darwin' : 'linux')

/**
 * Quick View's card: a link's page in a card over the page you're on, with round buttons beside it to
 * close it, open it as a tab, or open it in split view. The page itself is a view the main process lays
 * over the card once it has arrived (a native view can't be animated); until then the card is blank.
 */
export function QuickView({
  request,
  pageArea,
  onClose
}: {
  request: QuickViewRequest
  /** Where the tab's page is in the window: the card sits over it. */
  pageArea: Rect
  onClose: () => void
}): React.JSX.Element {
  const { id, origin, phase, image } = request
  const cardRef = useRef<HTMLDivElement>(null)
  const [settled, setSettled] = useState(false)

  const marginX = Math.round(Math.min(MARGIN.max, Math.max(MARGIN.min, pageArea.width * MARGIN.share)))
  const card = {
    left: pageArea.x + marginX,
    top: pageArea.y,
    width: Math.max(320, pageArea.width - marginX * 2),
    height: Math.max(240, pageArea.height)
  }
  // From the link (a little bigger than a thin line of text), or from just inside where the card will be.
  const from = origin
    ? {
        left: origin.x,
        top: origin.y,
        width: Math.max(origin.width, 40),
        height: Math.max(origin.height, 24),
        borderRadius: 6,
        opacity: 0
      }
    : {
        left: card.left + card.width * 0.03,
        top: card.top + card.height * 0.03,
        width: card.width * 0.94,
        height: card.height * 0.94,
        borderRadius: RADIUS,
        opacity: 0
      }

  // Where the page goes, once the card has arrived (and again whenever it changes size).
  useEffect(() => {
    const el = cardRef.current
    if (!el || !settled) return
    const send = (): void => {
      const box = el.getBoundingClientRect()
      const rect = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
      zepper.send({ type: 'quickView.area', id, rect })
    }
    send()
    const observer = new ResizeObserver(send)
    observer.observe(el)
    return () => {
      observer.disconnect()
      zepper.send({ type: 'quickView.area', id, rect: null })
    }
  }, [settled, id])

  // Closing without a picture: nothing to wait for.
  useEffect(() => {
    if (phase === 'closing' && !image) zepper.send({ type: 'quickView.covered', id })
  }, [phase, image, id])

  // While the card arrives the overlay has the keyboard (afterwards the page does, where main hears Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const send = (type: 'quickView.expand' | 'quickView.split'): void => {
    if (phase === 'open') zepper.send({ type, id })
  }

  return (
    <motion.div
      className="quick-view-backdrop"
      initial={{ opacity: 1 }}
      exit={{ opacity: 1, transition: { duration: 0.24 } }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        ref={cardRef}
        className="quick-view"
        role="dialog"
        aria-label="Quick View"
        initial={from}
        animate={phase === 'expanding' ? { ...card, borderRadius: RADIUS, opacity: 0 } : { ...card, borderRadius: RADIUS, opacity: 1 }}
        exit={{ ...from, opacity: [1, 1, 0], transition: { duration: 0.24, ease: [0.4, 0, 0.9, 0.6] } }}
        transition={phase === 'expanding' ? { duration: 0 } : { type: 'spring', bounce: 0.12, duration: 0.42, opacity: { duration: 0.12 } }}
        onAnimationComplete={() => phase === 'open' && setSettled(true)}
      >
        {phase === 'closing' && image && (
          <img
            className="quick-view-picture"
            src={image}
            alt=""
            onLoad={() => requestAnimationFrame(() => requestAnimationFrame(() => zepper.send({ type: 'quickView.covered', id })))}
          />
        )}
      </motion.div>
      <motion.div
        className="quick-view-buttons"
        style={{ left: card.left - SIDE_GAP - BUTTON, top: card.top + 4, gap: BUTTON_GAP }}
        initial={{ opacity: 0, x: 10 }}
        animate={phase === 'open' ? { opacity: 1, x: 0, transition: { delay: 0.12, duration: 0.2 } } : { opacity: 0, x: 6 }}
        exit={{ opacity: 0, transition: { duration: 0.1 } }}
      >
        <button className="quick-view-button" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          <X size={15} strokeWidth={2.4} />
        </button>
        <button
          className="quick-view-button"
          title={`Open as Tab (${EXPAND_KEYS})`}
          aria-label="Open as Tab"
          onClick={() => send('quickView.expand')}
        >
          <Maximize2 size={14} strokeWidth={2.3} />
        </button>
        <button
          className="quick-view-button"
          title="Open in Split View"
          aria-label="Open in Split View"
          onClick={() => send('quickView.split')}
        >
          <Columns2 size={15} strokeWidth={2.2} />
        </button>
      </motion.div>
    </motion.div>
  )
}
