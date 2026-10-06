import { useEffect, useRef } from 'react'
import { motion } from 'motion/react'
import type { Snapshot } from '@shared/types'
import { zepper } from '../bridge'
import { Background } from '../chrome/App'
import { Sidebar } from '../chrome/Sidebar'

const HIDE_DELAY_MS = 250
const NEVER_ENTERED_MS = 1500

interface PeekProps {
  snapshot: Snapshot
  onHide: () => void
  /** The pointer came back while the card was sliding out: bring it back. */
  onShow: () => void
}

/**
 * Compact mode's floating sidebar: slides in from the window edge on hover.
 * The hover area runs from the window edge to just past the card,
 * so resting the pointer against the edge (where you naturally push it) keeps
 * it open; it leaves shortly after the pointer moves away, and coming back
 * while it slides out brings it straight back.
 */
export function Peek({ snapshot, onHide, onShow }: PeekProps): React.JSX.Element {
  const timer = useRef(0)
  // Shown because the pointer touched the edge, but it never came onto the card (it went off the
  // window, say): it leaves on its own rather than staying open.
  const hide = useRef(onHide)
  hide.current = onHide
  useEffect(() => {
    timer.current = window.setTimeout(() => {
      zepper.send({ type: 'ui.peekLights', visible: false })
      hide.current()
    }, NEVER_ENTERED_MS)
    return () => window.clearTimeout(timer.current)
  }, [])
  const right = snapshot.settings.sidebarPosition === 'right'
  const space = snapshot.spaces.find((s) => s.id === snapshot.activeSpaceId) ?? snapshot.spaces[0]
  const offscreen = right ? '110%' : '-110%'

  return (
    <motion.div
      className={`peek-zone${right ? ' right' : ''}`}
      style={{ width: snapshot.sidebarWidth + 12 }}
      initial={{ x: offscreen }}
      animate={{ x: 0 }}
      exit={{ x: offscreen, transition: { type: 'spring', bounce: 0, duration: 0.22 } }}
      transition={{ type: 'spring', bounce: 0.18, duration: 0.32 }}
      // The traffic lights belong to the card: on once it has arrived, off as soon as it leaves.
      onAnimationComplete={(definition) => {
        if ((definition as { x?: unknown }).x === 0) zepper.send({ type: 'ui.peekLights', visible: true })
      }}
      onMouseEnter={() => {
        window.clearTimeout(timer.current)
        onShow()
      }}
      onMouseLeave={() => {
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => {
          zepper.send({ type: 'ui.peekLights', visible: false })
          onHide()
        }, HIDE_DELAY_MS)
      }}
    >
      <div className="peek-card">
        {/* The window's own background, window-sized and offset, so the card shows exactly the slice
            the docked sidebar does (solid: there's no desktop to see through over a page). */}
        <div
          className={`peek-background${right ? ' right' : ''}`}
          style={{ width: snapshot.windowSize.width || '100vw', height: snapshot.windowSize.height || '100vh' }}
        >
          <Background theme={space.theme} spaceKey={space.id} transparency={0} />
        </div>
        <Sidebar snapshot={snapshot} width={snapshot.sidebarWidth} onResize={() => {}} floating />
      </div>
    </motion.div>
  )
}
