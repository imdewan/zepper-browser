import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, animate, motion, useMotionValue } from 'motion/react'
import type { Folder, Snapshot, Space, Split, Tab } from '@shared/types'
import { zepper } from '../bridge'
import { IconArrowDown, IconChevronDown, IconChevronUpDown, IconDots, IconPlus, IconSparkle } from '../icons'
import { cx, rectOf } from '../util'
import { SplitRow } from './SplitRow'
import { useDragging, useDrop } from './dnd'
import { Essentials } from './Essentials'
import { FolderRow } from './FolderRow'
import { StaleTabs } from './StaleTabs'
import { TabRow, type RowPlace } from './TabRow'

/** Tab rows for a section, with each split collapsed into one grouped row at its first member. */
function renderRows(
  tabs: Tab[],
  all: Tab[],
  splits: Split[],
  activeTabId: string | null,
  placeOf?: (tab: Tab, index: number) => RowPlace
): React.JSX.Element[] {
  const rendered = new Set<string>()
  const rows: React.JSX.Element[] = []
  tabs.forEach((tab, index) => {
    const split = splits.find((s) => s.tabIds.includes(tab.id))
    if (!split) {
      rows.push(<TabRow key={tab.id} tab={tab} active={tab.id === activeTabId} place={placeOf?.(tab, index)} />)
      return
    }
    if (rendered.has(split.id)) return
    rendered.add(split.id)
    const members = split.tabIds.map((id) => all.find((t) => t.id === id)).filter((t): t is Tab => !!t)
    rows.push(<SplitRow key={`split-${split.id}`} split={split} tabs={members} activeTabId={activeTabId} />)
  })
  return rows
}

/**
 * A space's pinned area as a tree of folders and tabs. Collapsed folders still show the
 * tab you're on.
 */
function pinnedRows(
  items: string[],
  parentId: string | null,
  depth: number,
  ctx: { space: Space; tabs: Map<string, Tab>; folders: Map<string, Folder>; all: Tab[]; splits: Split[]; activeTabId: string | null }
): React.JSX.Element[] {
  const rows: React.JSX.Element[] = []
  const tabsUnder = (ids: string[]): string[] => ids.flatMap((id) => (ctx.folders.has(id) ? tabsUnder(ctx.folders.get(id)!.items) : [id]))
  items.forEach((id, index) => {
    const place: RowPlace = { zone: 'pinned', spaceId: ctx.space.id, parentId, index, depth }
    const folder = ctx.folders.get(id)
    if (folder) {
      const inside = tabsUnder(folder.items)
      rows.push(<FolderRow key={`folder-${id}`} folder={folder} place={place} count={inside.length} />)
      if (!folder.collapsed) rows.push(...pinnedRows(folder.items, folder.id, depth + 1, ctx))
      else if (ctx.activeTabId && inside.includes(ctx.activeTabId)) {
        const active = ctx.tabs.get(ctx.activeTabId)
        if (active)
          rows.push(
            <TabRow
              key={active.id}
              tab={active}
              active
              place={{ ...place, parentId: folder.id, index: folder.items.indexOf(active.id), depth: depth + 1 }}
            />
          )
      }
      return
    }
    const tab = ctx.tabs.get(id)
    if (tab) rows.push(...renderRows([tab], ctx.all, ctx.splits, ctx.activeTabId, () => place))
  })
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

/** A pause this long ends a wheel stream. */
const QUIET_MS = 140

/**
 * All spaces laid side by side; the track slides to the active one with a
 * critically damped 250ms spring. Two-finger horizontal swipes drag the track
 * directly and switch once they pass a threshold.
 *
 * Each wheel stream is classified once (vertical scrolling is left alone).
 * The sidebar decides the target space itself, so back-to-back swipes build on
 * where the track visually is instead of waiting for the main process. After
 * a switch, the momentum tail is ignored, but a new swipe is recognised at
 * once: momentum only ever shrinks, a new swipe grows.
 */
export function SpacesViewport({ snapshot, renamingId, onRenameDone, onStartRename }: SpacesViewportProps): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null)
  const width = useWidth(viewport)
  const index = Math.max(
    0,
    snapshot.spaces.findIndex((s) => s.id === snapshot.activeSpaceId)
  )
  const count = snapshot.spaces.length
  const x = useMotionValue(0)
  const gesture = useRef({
    mode: 'idle' as 'idle' | 'pending' | 'drag' | 'ignore' | 'locked',
    /** After a switch: still the same swipe ('finger'), or its momentum ('momentum'). */
    lockPhase: 'finger' as 'finger' | 'momentum',
    dx: 0,
    dy: 0,
    offset: 0,
    lastDelta: 0,
    shrinking: 0,
    rising: 0,
    timer: 0,
    /** The space we've switched to but the snapshot hasn't caught up with yet. */
    pending: null as number | null,
    pendingAt: 0,
    /** Where the track is heading, so a snapshot confirming it doesn't restart the spring. */
    target: -1
  })
  const indexRef = useRef(index)
  indexRef.current = index
  const spaceIds = useRef<string[]>([])
  spaceIds.current = snapshot.spaces.map((s) => s.id)
  const laidOutWidth = useRef(0)

  useEffect(() => {
    const g = gesture.current
    // A confirmed switch clears the pending one; a stale one (the main process went elsewhere) expires.
    if (g.pending !== null && (index === g.pending || Date.now() - g.pendingAt > 1000)) g.pending = null
    if (!width || g.mode === 'drag' || g.pending !== null) return
    if (laidOutWidth.current !== width) {
      // First layout or a sidebar resize: place the track, no animation.
      laidOutWidth.current = width
      x.stop()
      x.set(-index * width)
      g.target = index
      return
    }
    // Already heading there (we switched locally): let the running spring finish.
    if (g.target === index) return
    g.target = index
    void animate(x, -index * width, SWITCH_SPRING)
  }, [index, width, x])

  const swipeEnabled = snapshot.settings.swipeBetweenSpaces
  const wrap = snapshot.settings.wrapSpaces
  useEffect(() => {
    // Swipes work anywhere on the sidebar, not just over the tab list.
    const el = viewport.current?.closest<HTMLElement>('.sidebar') ?? viewport.current
    if (!el || !width || !swipeEnabled) return
    const g = gesture.current
    const current = (): number => g.pending ?? indexRef.current

    const slideTo = (target: number): void => {
      g.target = target
      void animate(x, -target * width, SWITCH_SPRING)
    }
    /** Switches by one space from where the track is, wrapping if allowed. */
    const commit = (delta: number): void => {
      const from = current()
      let target = from + delta
      if (target < 0 || target >= count) {
        if (!wrap || count < 2) return slideTo(from)
        target = (target + count) % count
        // Wrapping: start the new space just past the edge it comes in from, rather than
        // flying across every space in between.
        x.set(-target * width + (delta > 0 ? width : -width) + (x.get() + from * width))
      }
      g.pending = target
      g.pendingAt = Date.now()
      slideTo(target)
      const id = spaceIds.current[target]
      if (id) zepper.send({ type: 'space.switch', spaceId: id })
    }
    /** Fingers lifted (or paused): switch if dragged far enough, otherwise spring back. */
    const release = (): void => {
      if (g.mode !== 'drag') return
      if (Math.abs(g.offset) > width * 0.15 && count > 1) commit(g.offset < 0 ? 1 : -1)
      else slideTo(current())
      g.mode = 'idle'
      g.offset = 0
    }
    const endStream = (): void => {
      release()
      g.mode = 'idle'
      g.dx = g.dy = g.lastDelta = g.shrinking = g.rising = 0
    }
    const startDrag = (): void => {
      x.stop()
      g.mode = 'drag'
      // Pick up from wherever the track is, even mid-animation.
      g.offset = x.get() + current() * width
      g.shrinking = 0
    }

    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) return
      window.clearTimeout(g.timer)
      g.timer = window.setTimeout(endStream, QUIET_MS)
      const delta = Math.abs(e.deltaX)

      if (g.mode === 'ignore') return
      if (g.mode === 'locked') {
        e.preventDefault()
        if (g.lockPhase === 'finger') {
          // Still the swipe that switched; once it starts decaying, it's momentum.
          g.shrinking = delta < g.lastDelta ? g.shrinking + 1 : 0
          if (g.shrinking >= 3) {
            g.lockPhase = 'momentum'
            g.rising = 0
          }
        } else {
          // Momentum only shrinks; growing deltas mean new fingers: a new swipe.
          g.rising = delta > g.lastDelta + 1 ? g.rising + 1 : 0
          if (g.rising >= 2) {
            g.lastDelta = delta
            startDrag()
            g.offset -= e.deltaX
            x.set(-current() * width + g.offset)
            return
          }
        }
        g.lastDelta = delta
        return
      }

      if (g.mode === 'idle') {
        // Swiping over the space emojis scrolls them (when they overflow); it never switches spaces.
        if (e.target instanceof Element && e.target.closest('.space-switcher')) {
          g.mode = 'ignore'
          return
        }
        g.mode = 'pending'
        g.dx = g.dy = 0
      }
      if (g.mode === 'pending') {
        g.dx += e.deltaX
        g.dy += e.deltaY
        const ax = Math.abs(g.dx)
        const ay = Math.abs(g.dy)
        if (ay > 6 && ay >= ax * 0.8) {
          g.mode = 'ignore' // Scrolling the tab list.
          return
        }
        if (ax < 6) return
        if (ax < ay * 1.5) {
          g.mode = 'ignore'
          return
        }
        startDrag()
        g.offset -= g.dx
      } else {
        g.offset -= e.deltaX
        // Momentum after the fingers lift: decide now instead of when it dies out.
        g.shrinking = delta > 0 && delta < g.lastDelta ? g.shrinking + 1 : delta === g.lastDelta ? g.shrinking : 0
        if (g.shrinking >= 4) {
          e.preventDefault()
          release()
          g.mode = 'locked'
          g.lockPhase = 'momentum'
          g.lastDelta = delta
          g.rising = 0
          return
        }
      }
      e.preventDefault()
      g.lastDelta = delta

      const from = current()
      const atStart = !wrap && from === 0 && g.offset > 0
      const atEnd = !wrap && from === count - 1 && g.offset < 0
      const shown = atStart || atEnd ? g.offset * 0.25 : g.offset
      x.set(-from * width + Math.max(-width, Math.min(width, shown)))
      if (!atStart && !atEnd && count > 1 && Math.abs(g.offset) > width * 0.3) {
        commit(g.offset < 0 ? 1 : -1)
        g.offset = 0
        g.mode = 'locked'
        g.lockPhase = 'finger'
        g.shrinking = 0
      }
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
            folders={snapshot.folders}
            newTabAtBottom={snapshot.settings.newTabPosition === 'bottom'}
            tidy={snapshot.settings.showTidy ? snapshot.tidy : null}
            staleDays={snapshot.settings.staleTabDays}
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
  folders: Folder[]
  newTabAtBottom: boolean
  /** How Tidy works here, or null when its button is turned off. */
  tidy: Snapshot['tidy'] | null
  /** Suggest closing tabs not opened for this many days (0: never). */
  staleDays: number
  renaming: boolean
  onRenameDone: () => void
  onStartRename: () => void
}

function SpaceView({
  space,
  tabs,
  activeTabId,
  splits,
  folders,
  newTabAtBottom,
  tidy,
  renaming,
  onRenameDone,
  onStartRename,
  staleDays
}: SpaceViewProps): React.JSX.Element {
  const pinned = tabs.filter((t) => t.kind === 'pinned' && t.spaceId === space.id)
  const normal = tabs.filter((t) => t.kind === 'normal' && t.spaceId === space.id)
  const canClear = normal.some((t) => t.id !== activeTabId && !t.audible)
  const dragging = useDragging()
  const ctx = {
    space,
    tabs: new Map(tabs.map((t) => [t.id, t])),
    folders: new Map(folders.filter((f) => f.spaceId === space.id).map((f) => [f.id, f])),
    all: tabs,
    splits,
    activeTabId
  }
  const hasPinnedArea = space.pinnedItems.length > 0
  // Collapsed pinned area: just the pinned tab you're on.
  const pinnedArea = space.collapsedPins
    ? renderRows(
        pinned.filter((t) => t.id === activeTabId),
        tabs,
        splits,
        activeTabId
      )
    : pinnedRows(space.pinnedItems, null, 0, ctx)
  const normalPlace = (_tab: Tab, index: number): RowPlace => ({ zone: 'normal', spaceId: space.id, parentId: null, index, depth: 0 })

  return (
    <section className="space">
      <Essentials
        tabs={tabs.filter((t) => t.kind === 'essential' && t.spaceId === space.id)}
        spaceId={space.id}
        activeTabId={activeTabId}
      />
      <SpaceHeader space={space} hasPinned={hasPinnedArea} renaming={renaming} onRenameDone={onRenameDone} onStartRename={onStartRename} />
      <div className="space-scroll">
        <AnimatePresence initial={false}>{pinnedArea}</AnimatePresence>
        {dragging && <PinZone spaceId={space.id} index={space.pinnedItems.length} empty={!hasPinnedArea} />}

        <div className={cx('pinned-separator', normal.length === 0 && 'hidden')}>
          <span className="separator-line" />
          {tidy && normal.length >= 3 && (
            <button
              className="clear-button tidy-button"
              title={
                tidy.kind === 'ai'
                  ? 'Group related tabs into folders with Apple Intelligence'
                  : `Group tabs from the same site into folders. ${tidy.reason}`
              }
              onClick={() => zepper.send({ type: 'space.tidy', spaceId: space.id })}
            >
              <IconSparkle size={10} />
              Tidy
            </button>
          )}
          <button
            className={cx('clear-button', canClear && 'can-clear')}
            title="Close all unpinned tabs (⌘⇧K)"
            onClick={() => zepper.send({ type: 'space.clearTabs', spaceId: space.id })}
          >
            Clear
            <IconArrowDown size={10} />
          </button>
        </div>

        <AnimatePresence initial={false}>
          <StaleTabs
            key="stale"
            space={space}
            tabs={normal}
            activeTabId={activeTabId}
            busy={new Set(splits.flatMap((s) => s.tabIds))}
            days={staleDays}
          />
        </AnimatePresence>
        {!newTabAtBottom && <NewTabRow spaceId={space.id} index={0} />}
        <AnimatePresence initial={false}>{renderRows(normal, tabs, splits, activeTabId, normalPlace)}</AnimatePresence>
        {newTabAtBottom && <NewTabRow spaceId={space.id} index={normal.length} />}
        <SpaceFill spaceId={space.id} index={normal.length} />
      </div>
    </section>
  )
}

/** While dragging: the end of the pinned area (a "drop here to pin" placeholder when it's empty). */
function PinZone({ spaceId, index, empty }: { spaceId: string; index: number; empty: boolean }): React.JSX.Element {
  const drop = useDrop({ key: `pin-zone:${spaceId}`, whole: 'after', target: () => ({ zone: 'pinned', spaceId, parentId: null, index }) })
  return (
    <div {...drop.props} className={cx('pin-zone', empty && 'empty', drop.position && 'over')}>
      {empty && 'Drop here to pin'}
    </div>
  )
}

/** The space below the tabs: double-click for a new tab; drop a tab to put it at the end. */
function SpaceFill({ spaceId, index }: { spaceId: string; index: number }): React.JSX.Element {
  const drop = useDrop({
    key: `fill:${spaceId}`,
    whole: 'before',
    target: (_position, item) => (item.kind === 'tab' ? { zone: 'normal', spaceId, index } : null)
  })
  return (
    <div
      {...drop.props}
      className={cx('space-fill', drop.position && 'dnd-before')}
      onDoubleClick={() => zepper.send({ type: 'ui.openPalette', mode: 'new' })}
    />
  )
}

function NewTabRow({ spaceId, index }: { spaceId: string; index: number }): React.JSX.Element {
  const drop = useDrop({
    key: `new-tab:${spaceId}`,
    whole: index === 0 ? 'after' : 'before',
    target: (_position, item) => (item.kind === 'tab' ? { zone: 'normal', spaceId, index } : null)
  })
  return (
    <button
      {...drop.props}
      className={cx('new-tab-row', drop.position && `dnd-${drop.position}`)}
      onClick={() => zepper.send({ type: 'ui.openPalette', mode: 'new' })}
    >
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
        <span className="space-title">
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
          <button
            className="space-picker-button"
            title="Switch space"
            onClick={(e) => {
              e.stopPropagation()
              window.clearTimeout(clickTimer.current)
              if (ref.current) zepper.send({ type: 'ui.openPopover', popover: { kind: 'spaces', anchor: rectOf(ref.current) } })
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <IconChevronUpDown size={12} />
          </button>
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
