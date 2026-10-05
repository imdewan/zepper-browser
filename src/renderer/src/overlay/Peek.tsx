import { useRef } from 'react'
import { motion } from 'motion/react'
import { themeBackground } from '@shared/theme'
import type { Snapshot } from '@shared/types'
import { zepper } from '../bridge'
import { Sidebar } from '../chrome/Sidebar'

const HIDE_DELAY_MS = 250

interface PeekProps {
  snapshot: Snapshot
  onHide: () => void
  /** The pointer came back while the card was sliding out: bring it back. */
  onShow: () => void
}

/**
 * Compact mode's floating sidebar: slides in from the window edge on hover,
 * like Zen. The hover area runs from the window edge to just past the card,
 * so resting the pointer against the edge (where you naturally push it) keeps
 * it open; it leaves shortly after the pointer moves away, and coming back
 * while it slides out brings it straight back.
 */
export function Peek({ snapshot, onHide, onShow }: PeekProps): React.JSX.Element {
  const timer = useRef(0)
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
        <div className="peek-background" style={{ background: themeBackground(space.theme) }} />
        <Sidebar snapshot={snapshot} width={snapshot.sidebarWidth} onResize={() => {}} floating />
      </div>
    </motion.div>
  )
}
