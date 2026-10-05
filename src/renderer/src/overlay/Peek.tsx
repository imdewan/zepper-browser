import { useRef } from 'react'
import { motion } from 'motion/react'
import { themeBackground } from '@shared/theme'
import type { Snapshot } from '@shared/types'
import { Sidebar } from '../chrome/Sidebar'

const HIDE_DELAY_MS = 150

interface PeekProps {
  snapshot: Snapshot
  onHide: () => void
}

/**
 * Compact mode's floating sidebar: slides in from the window edge on hover,
 * stays while the pointer is over it, and leaves 150ms after it exits (Zen's
 * keep-hover delay). Spring with a slight overshoot, like Zen's reveal.
 */
export function Peek({ snapshot, onHide }: PeekProps): React.JSX.Element {
  const timer = useRef(0)
  const right = snapshot.settings.sidebarPosition === 'right'
  const space = snapshot.spaces.find((s) => s.id === snapshot.activeSpaceId) ?? snapshot.spaces[0]
  const offscreen = right ? '110%' : '-110%'

  return (
    <motion.div
      className={`peek-card${right ? ' right' : ''}`}
      style={{ width: snapshot.sidebarWidth }}
      initial={{ x: offscreen }}
      animate={{ x: 0 }}
      exit={{ x: offscreen, transition: { type: 'spring', bounce: 0, duration: 0.22 } }}
      transition={{ type: 'spring', bounce: 0.18, duration: 0.32 }}
      onMouseEnter={() => window.clearTimeout(timer.current)}
      onMouseLeave={() => {
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(onHide, HIDE_DELAY_MS)
      }}
    >
      <div className="peek-background" style={{ background: themeBackground(space.theme) }} />
      <Sidebar snapshot={snapshot} width={snapshot.sidebarWidth} onResize={() => {}} floating />
    </motion.div>
  )
}
