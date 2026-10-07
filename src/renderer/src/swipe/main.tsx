import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/base.css'
import '../styles/swipe.css'
import { zepper } from '../bridge'
import { LinkStatus } from './LinkStatus'
import { SwipeArrow } from './SwipeArrow'

/** The small view above the page: the swipe arrow, or a link's address (one at a time). */
function PageHints(): React.JSX.Element {
  const [showing, setShowing] = useState<'swipe' | 'link'>('swipe')
  useEffect(
    () =>
      zepper.onEvent((event) => {
        if (event.type === 'swipe.progress') setShowing('swipe')
        else if (event.type === 'link.status' && event.url !== null) setShowing('link')
      }),
    []
  )
  return (
    <>
      {/* Hidden, not removed: the link bubble measures itself whichever was showing before. */}
      <div style={{ visibility: showing === 'swipe' ? 'visible' : 'hidden' }}>
        <SwipeArrow />
      </div>
      <div style={{ visibility: showing === 'link' ? 'visible' : 'hidden' }}>
        <LinkStatus />
      </div>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<PageHints />)
