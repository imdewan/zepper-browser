import { useEffect, useState } from 'react'
import type { UiEvent } from '@shared/types'
import { zepper } from '../bridge'
import { cx } from '../util'

type Swipe = Extract<UiEvent, { type: 'swipe.progress' }>

/** The ring's circumference (r = 21 in a 48-unit box). */
const RING = 2 * Math.PI * 21
/** How far the arrow travels in from the page's edge as you swipe. */
const TRAVEL = 72

/**
 * The back/forward arrow at the page's edge during a two-finger swipe (see Browser.onPageSwipe). It
 * slides in with your fingers while a ring fills; once letting go would navigate, the circle fills in
 * the space's colour. It pops as it navigates, or slides back out if you let go too soon.
 */
export function SwipeArrow(): React.JSX.Element | null {
  const [swipe, setSwipe] = useState<Swipe | null>(null)
  useEffect(
    () =>
      zepper.onEvent((event) => {
        if (event.type === 'swipe.progress') setSwipe(event)
      }),
    []
  )
  if (!swipe) return null
  const back = swipe.direction === 'back'
  // Eased, so the arrow leads your fingers at first and settles as it nears the mark.
  const eased = 1 - Math.pow(1 - swipe.progress, 3)
  const offset = (back ? -1 : 1) * (1 - eased) * TRAVEL
  return (
    <div
      className={cx('swipe', swipe.direction, swipe.armed && 'armed', swipe.phase !== 'move' && swipe.phase)}
      style={{ '--accent': swipe.accent, '--offset': `${offset}px`, '--away': `${(back ? -1 : 1) * TRAVEL}px` } as React.CSSProperties}
    >
      <div className="swipe-bubble">
        <svg className="swipe-ring" viewBox="0 0 48 48" aria-hidden="true">
          <circle cx="24" cy="24" r="21" style={{ strokeDasharray: RING, strokeDashoffset: RING * (1 - swipe.progress) }} />
        </svg>
        <svg className="swipe-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d={back ? 'M19 12H5M12 19l-7-7 7-7' : 'M5 12h14M12 5l7 7-7 7'} />
        </svg>
      </div>
    </div>
  )
}
