import { AnimatePresence, motion } from 'motion/react'
import type { Tab } from '@shared/types'
import { zepper } from '../bridge'
import { Favicon } from '../Favicon'
import { Equalizer, IconMuted } from '../icons'
import { cx } from '../util'

/** Column count that keeps rows balanced, mirroring Zen's grid tweaks (5 → 3+2, 6 → 3+3, 9 → 3×3). */
function columnsFor(count: number): number {
  if (count <= 4) return Math.max(count, 1)
  if (count === 5 || count === 6 || count === 9) return 3
  return 4
}

interface EssentialsProps {
  tabs: Tab[]
  activeTabId: string | null
}

export function Essentials({ tabs, activeTabId }: EssentialsProps): React.JSX.Element | null {
  if (tabs.length === 0) return null
  return (
    <div className="essentials" style={{ '--cols': columnsFor(tabs.length) } as React.CSSProperties}>
      <AnimatePresence initial={false}>
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <motion.button
              key={tab.id}
              layout
              className={cx('essential', active && 'active', !tab.loaded && 'unloaded')}
              title={tab.title}
              style={{ '--icon': tab.favicon ? `url("${tab.favicon}")` : 'none' } as React.CSSProperties}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: 'spring', bounce: 0, duration: 0.25 }}
              onClick={() => zepper.send({ type: 'tab.activate', tabId: tab.id })}
              onDoubleClick={() => zepper.send({ type: 'tab.resetPinned', tabId: tab.id })}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onAuxClick={(e) => e.button === 1 && zepper.send({ type: 'tab.middleClick', tabId: tab.id })}
              onContextMenu={(e) => {
                e.preventDefault()
                zepper.send({ type: 'tab.contextMenu', tabId: tab.id })
              }}
            >
              {active && <span className="essential-glow" />}
              {active && <span className="essential-fill" />}
              <Favicon src={tab.favicon} size={18} />
              {(tab.audible || tab.muted) && (
                <span
                  role="button"
                  className={cx('essential-audio', tab.muted && 'muted')}
                  title={tab.muted ? 'Unmute tab' : 'Mute tab'}
                  onClick={(e) => {
                    e.stopPropagation()
                    zepper.send({ type: 'tab.toggleMute', tabId: tab.id })
                  }}
                >
                  {tab.muted ? <IconMuted size={10} /> : <Equalizer />}
                </span>
              )}
            </motion.button>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
