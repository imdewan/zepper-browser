import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, animate, motion, useMotionValue } from 'motion/react'
import type { Snapshot, Space, Split, Tab } from '@shared/types'
import { zepper } from '../bridge'
import { IconArrowDown, IconChevronDown, IconDots, IconPlus } from '../icons'
import { cx, rectOf } from '../util'
import { SplitRow } from './SplitRow'
import { TabRow } from './TabRow'

/** Tab rows for a section, with each split collapsed into one grouped row at its first member. */
function renderRows(tabs: Tab[], all: Tab[], splits: Split[], activeTabId: string | null): React.JSX.Element[] {
  const rendered = new Set<string>()
  const rows: React.JSX.Element[] = []
  for (const tab of tabs) {
    const split = splits.find((s) => s.tabIds.includes(tab.id))
    if (!split) {
      rows.push(<TabRow key={tab.id} tab={tab} active={tab.id === activeTabId} />)
      continue
    }
    if (rendered.has(split.id)) continue
    rendered.add(split.id)
    const members = split.tabIds.map((id) => all.find((t) => t.id === id)).filter((t): t is Tab => !!t)
    rows.push(<SplitRow key={`split-${split.id}`} split={split} tabs={members} activeTabId={activeTabId} />)
  }
  return rows
}

const SWITCH_SPRING = { type: 'spring', bounce: 0, duration: 0.25 } as const

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    setWidth(el.getBoundingClientRect().width)
    return () => observer.disconnect()
  }, [ref])
  return width
}

interface SpacesViewportProps {
  snapshot: Snapshot
  renamingId: string | null
  onRenameDone: () => void
  onStartRename: (spaceId: string) => void
}

/**
 * All spaces laid side by side; the track slides to the active one with a
 * critically damped 250ms spring. Two-finger horizontal swipes drag the track
 * directly and switch once they pass a threshold, like Zen.
 */
export function SpacesViewport({ snapshot, renamingId, onRenameDone, onStartRename }: SpacesViewportProps): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null)
  const width = useWidth(viewport)
  const index = Math.max(0, snapshot.spaces.findIndex((s) => s.id === snapshot.activeSpaceId))
  const count = snapshot.spaces.length
  const x = useMotionValue(0)
  const gesture = useRef({ active: false, offset: 0, locked: false, timer: 0 })
  const indexRef = useRef(index)
  indexRef.current = index
  const firstLayout = useRef(true)

  useEffect(() => {
    if (!width || gesture.current.active) return
    if (firstLayout.current) {
      firstLayout.current = false
      x.set(-index * width)
      return
    }
    void animate(x, -index * width, SWITCH_SPRING)
  }, [index, width, x])

  const swipeEnabled = snapshot.settings.swipeBetweenSpaces
  const wrap = snapshot.settings.wrapSpaces
  useEffect(() => {
    // Swipes work anywhere on the sidebar, not just over the tab list.
    const el = viewport.current?.closest<HTMLElement>('.sidebar') ?? viewport.current
    if (!el || !width || !swipeEnabled) return
    const g = gesture.current
    const settle = (): void => {
      g.active = false
      g.locked = false
      if (Math.abs(g.offset) > width * 0.15 && count > 1) {
        commit(g.offset < 0 ? 1 : -1)
      } else {
        void animate(x, -indexRef.current * width, SWITCH_SPRING)
      }
      g.offset = 0
    }
    const commit = (delta: number): void => {
      const target = indexRef.current + delta
      if (!wrap && (target < 0 || target >= count)) {
        void animate(x, -indexRef.current * width, SWITCH_SPRING)
        return
      }
      // The main process wraps past the ends when "Wrap around spaces" is on.
      zepper.send({ type: 'space.switchRelative', delta })
    }
    const onWheel = (e: WheelEvent): void => {
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY)
      if (!g.active && !g.locked && !horizontal) return
      e.preventDefault()
      window.clearTimeout(g.timer)
      if (g.locked) {
        // Ignore trailing momentum after a committed switch.
        g.timer = window.setTimeout(() => (g.locked = false), 180)
        return
      }
      g.active = true
      g.offset -= e.deltaX
      const atStart = !wrap && indexRef.current === 0 && g.offset > 0
      const atEnd = !wrap && indexRef.current === count - 1 && g.offset < 0
      const shown = atStart || atEnd ? g.offset * 0.25 : g.offset
      x.set(-indexRef.current * width + Math.max(-width, Math.min(width, shown)))
      if (!atStart && !atEnd && Math.abs(g.offset) > width * 0.3) {
        const delta = g.offset < 0 ? 1 : -1
        g.active = false
        g.locked = true
        g.offset = 0
        commit(delta)
        g.timer = window.setTimeout(() => (g.locked = false), 180)
        return
      }
      g.timer = window.setTimeout(settle, 140)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      window.clearTimeout(g.timer)
    }
  }, [width, count, x, swipeEnabled, wrap])

  return (
    <div className="spaces-viewport" ref={viewport}>
      <motion.div className="spaces-track" style={{ x }}>
        {snapshot.spaces.map((space) => (
          <SpaceView
            key={space.id}
            space={space}
            tabs={snapshot.tabs}
            activeTabId={snapshot.activeTabId}
            splits={snapshot.splits}
            newTabAtBottom={snapshot.settings.newTabPosition === 'bottom'}
            renaming={renamingId === space.id}
            onRenameDone={onRenameDone}
            onStartRename={() => onStartRename(space.id)}
          />
        ))}
      </motion.div>
    </div>
  )
}

interface SpaceViewProps {
  space: Space
  tabs: Tab[]
  activeTabId: string | null
  splits: Split[]
  newTabAtBottom: boolean
  renaming: boolean
  onRenameDone: () => void
  onStartRename: () => void
}

function SpaceView({ space, tabs, activeTabId, splits, newTabAtBottom, renaming, onRenameDone, onStartRename }: SpaceViewProps): React.JSX.Element {
  const pinned = tabs.filter((t) => t.kind === 'pinned' && t.spaceId === space.id)
  const normal = tabs.filter((t) => t.kind === 'normal' && t.spaceId === space.id)
  const shownPinned = space.collapsedPins ? pinned.filter((t) => t.id === activeTabId) : pinned
  const canClear = normal.some((t) => t.id !== activeTabId && !t.audible)

  return (
    <section className="space">
      <SpaceHeader
        space={space}
        hasPinned={pinned.length > 0}
        renaming={renaming}
        onRenameDone={onRenameDone}
        onStartRename={onStartRename}
      />
      <div className="space-scroll">
        <AnimatePresence initial={false}>{renderRows(shownPinned, tabs, splits, activeTabId)}</AnimatePresence>

        <div className={cx('pinned-separator', normal.length === 0 && 'hidden')}>
          <span className="separator-line" />
          <button
            className={cx('clear-button', canClear && 'can-clear')}
            title="Close all unpinned tabs (⌘⇧K)"
            onClick={() => zepper.send({ type: 'space.clearTabs', spaceId: space.id })}
          >
            Clear
            <IconArrowDown size={10} />
          </button>
        </div>

        {!newTabAtBottom && <NewTabRow />}
        <AnimatePresence initial={false}>{renderRows(normal, tabs, splits, activeTabId)}</AnimatePresence>
        {newTabAtBottom && <NewTabRow />}
        <div className="space-fill" onDoubleClick={() => zepper.send({ type: 'ui.openPalette', mode: 'new' })} />
      </div>
    </section>
  )
}

function NewTabRow(): React.JSX.Element {
  return (
    <button className="new-tab-row" onClick={() => zepper.send({ type: 'ui.openPalette', mode: 'new' })}>
      <IconPlus size={15} />
      <span>New Tab</span>
    </button>
  )
}

interface SpaceHeaderProps {
  space: Space
  hasPinned: boolean
  renaming: boolean
  onRenameDone: () => void
  onStartRename: () => void
}

function SpaceHeader({ space, hasPinned, renaming, onRenameDone, onStartRename }: SpaceHeaderProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const clickTimer = useRef(0)

  const openMenu = (): void => {
    if (ref.current) zepper.send({ type: 'space.contextMenu', spaceId: space.id, anchor: rectOf(ref.current) })
  }
  const commitRename = (value: string): void => {
    if (value.trim() && value.trim() !== space.name) {
      zepper.send({ type: 'space.update', spaceId: space.id, patch: { name: value } })
    }
    onRenameDone()
  }

  return (
    <div
      ref={ref}
      className={cx('space-header', hasPinned && 'has-pinned', space.collapsedPins && 'collapsed')}
      onClick={() => {
        if (!hasPinned || renaming) return
        window.clearTimeout(clickTimer.current)
        clickTimer.current = window.setTimeout(() => {
          zepper.send({ type: 'space.update', spaceId: space.id, patch: { collapsedPins: !space.collapsedPins } })
        }, 220)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        openMenu()
      }}
    >
      <span className="space-icon">
        <span className="space-emoji">{space.icon}</span>
        {hasPinned && <IconChevronDown className="space-chevron" size={14} />}
      </span>
      {renaming ? (
        <input
          className="space-name-input"
          defaultValue={space.name}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename(e.currentTarget.value)
            if (e.key === 'Escape') onRenameDone()
          }}
          onBlur={(e) => commitRename(e.currentTarget.value)}
        />
      ) : (
        <span
          className="space-name"
          onDoubleClick={(e) => {
            e.stopPropagation()
            window.clearTimeout(clickTimer.current)
            onStartRename()
          }}
        >
          {space.name}
        </span>
      )}
      <button
        className="space-actions"
        title="Space options"
        onClick={(e) => {
          e.stopPropagation()
          openMenu()
        }}
      >
        <IconDots size={16} />
      </button>
    </div>
  )
}
