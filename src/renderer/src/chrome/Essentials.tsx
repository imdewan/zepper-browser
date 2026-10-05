import { AnimatePresence, motion } from 'motion/react'
import type { Tab } from '@shared/types'
import { zepper } from '../bridge'
import { Favicon } from '../Favicon'
import { Equalizer, IconMuted } from '../icons'
import { cx } from '../util'
import { dragProps, useDragging, useDrop } from './dnd'

/** Column count that keeps rows balanced (5 → 3+2, 6 → 3+3, 9 → 3×3). */
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
  const dragging = useDragging()
  const end = useDrop({
    key: 'essentials-end',
    whole: 'after',
    target: (_position, item) => (item.kind === 'tab' ? { zone: 'essentials', index: tabs.length } : null)
  })
  if (tabs.length === 0) {
    // Nothing yet: while dragging a tab, offer the spot.
    return dragging?.kind === 'tab' ? (
      <div {...end.props} className={cx('essentials-drop', end.position && 'over')}>
        Drop here to add to Essentials
      </div>
    ) : null
  }
  return (
    <div {...end.props} className="essentials" style={{ '--cols': columnsFor(tabs.length) } as React.CSSProperties}>
      <AnimatePresence initial={false}>
        {tabs.map((tab, index) => (
          <Essential key={tab.id} tab={tab} index={index} active={tab.id === activeTabId} />
        ))}
      </AnimatePresence>
    </div>
  )
}

function Essential({ tab, index, active }: { tab: Tab; index: number; active: boolean }): React.JSX.Element {
  const drop = useDrop({
    key: `essential:${tab.id}`,
    horizontal: true,
    target: (position, item) =>
      item.kind === 'tab' && item.id !== tab.id ? { zone: 'essentials', index: position === 'after' ? index + 1 : index } : null
  })
  return (
    <motion.div
      layout
      className={cx('essential-slot', drop.position && `dnd-${drop.position}`)}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ type: 'spring', bounce: 0, duration: 0.25 }}
    >
      <button
        {...dragProps({ kind: 'tab', id: tab.id })}
        {...drop.props}
        className={cx('essential', active && 'active', !tab.loaded && 'unloaded')}
        title={tab.title}
        style={{ '--icon': tab.favicon ? `url("${tab.favicon}")` : 'none' } as React.CSSProperties}
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
      </button>
    </motion.div>
  )
}
