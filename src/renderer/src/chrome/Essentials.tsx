import { useCallback, useRef } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Tab, UiEvent } from '@shared/types'
import { zepper } from '../bridge'
import { Favicon } from '../Favicon'
import { Equalizer, IconMuted } from '../icons'
import { useUiEvents } from '../useSnapshot'
import { cx, rectOf } from '../util'
import { dragProps, useDragging, useDrop, useDropHint, type DropPosition } from './dnd'

/** Column count that keeps rows balanced (5 → 3+2, 6 → 3+3, 9 → 3×3). */
function columnsFor(count: number): number {
  if (count <= 4) return Math.max(count, 1)
  if (count === 5 || count === 6 || count === 9) return 3
  return 4
}

interface EssentialsProps {
  /** This space's Essentials. */
  tabs: Tab[]
  spaceId: string
  activeTabId: string | null
}

/**
 * Where a drop lands in the grid: the row nearest the pointer, then before the first tile whose middle
 * is to the right of it (or after the row's last). Gaps between tiles count too.
 */
function slotAt(grid: HTMLElement, x: number, y: number): number {
  const rects = [...grid.querySelectorAll<HTMLElement>('.essential-slot')].map((el) => el.getBoundingClientRect())
  if (rects.length === 0) return 0
  const middle = (r: DOMRect): number => r.top + r.height / 2
  const rowTop = rects.reduce((best, r) => (Math.abs(middle(r) - y) < Math.abs(middle(best) - y) ? r : best)).top
  const row = rects.map((r, index) => ({ r, index })).filter(({ r }) => Math.abs(r.top - rowTop) < 2)
  const before = row.find(({ r }) => x < r.left + r.width / 2)
  return before ? before.index : row[row.length - 1].index + 1
}

/** A space's Essentials: a grid of its most-used sites, above its pinned and open tabs. */
export function Essentials({ tabs, spaceId, activeTabId }: EssentialsProps): React.JSX.Element | null {
  const dragging = useDragging()
  const end = useDrop({
    key: `essentials-end:${spaceId}`,
    whole: 'after',
    target: (_position, item, e) =>
      item.kind === 'tab' ? { zone: 'essentials', spaceId, index: tabs.length ? slotAt(e.currentTarget, e.clientX, e.clientY) : 0 } : null,
    // The indicator goes on the tile the drop lands next to.
    hint: (e) => {
      if (tabs.length === 0) return { key: `essentials-end:${spaceId}`, position: 'after' }
      const slot = slotAt(e.currentTarget, e.clientX, e.clientY)
      return slot < tabs.length
        ? { key: `essential:${tabs[slot].id}`, position: 'before' }
        : { key: `essential:${tabs[tabs.length - 1].id}`, position: 'after' }
    }
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
        {tabs.map((tab) => (
          <Essential key={tab.id} tab={tab} active={tab.id === activeTabId} />
        ))}
      </AnimatePresence>
    </div>
  )
}

function Essential({ tab, active }: { tab: Tab; active: boolean }): React.JSX.Element {
  // Drops are handled by the grid (so gaps count); the tile only shows where one would land.
  const position: DropPosition | null = useDropHint(`essential:${tab.id}`)
  const tile = useRef<HTMLButtonElement>(null)
  // "Change Icon…" from its menu: the emoji picker opens beside this tile (in whichever sidebar shows it).
  useUiEvents(
    useCallback(
      (event: UiEvent) => {
        if (event.type !== 'essential.pickIcon' || event.tabId !== tab.id || !tile.current || !tab.spaceId) return
        const anchor = rectOf(tile.current)
        if (anchor.width === 0 || tile.current.offsetParent === null) return
        zepper.send({ type: 'ui.openPopover', popover: { kind: 'emoji', spaceId: tab.spaceId, anchor, tabId: tab.id } })
      },
      [tab.id, tab.spaceId]
    )
  )
  return (
    <motion.div
      layout
      className={cx('essential-slot', position && `dnd-${position}`)}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ type: 'spring', bounce: 0, duration: 0.25 }}
    >
      <button
        ref={tile}
        {...dragProps({ kind: 'tab', id: tab.id })}
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
        {tab.emoji ? <span className="essential-emoji">{tab.emoji}</span> : <Favicon src={tab.favicon} size={18} />}
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
