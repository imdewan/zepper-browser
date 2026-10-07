import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { prefersDarkUi, themeAccent, themeBackground } from '@shared/theme'
import type { Settings } from '@shared/settings'
import type { Rect, Snapshot, SpaceTheme, Tab } from '@shared/types'
import { zepper } from '../bridge'
import { IconPrivate } from '../icons'
import { useSnapshot, useSystemDark } from '../useSnapshot'
import logo from '../assets/logo.png'
import { cx } from '../util'
import { Sidebar } from './Sidebar'

export const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .5 0 0 0 0 .5 0 0 0 0 .5 0 0 0 .9 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

const TITLEBAR_STRIP = 34

/** CSS variables describing the window layout, shared by both renderers. */
export function layoutVars(snapshot: Snapshot, sidebarWidth: number, accent: string | null): React.CSSProperties {
  const s = snapshot.settings
  const showSidebar = !snapshot.compact && !snapshot.fullscreen
  const right = s.sidebarPosition === 'right'
  const side = showSidebar ? sidebarWidth : s.contentGap
  return {
    '--gap': `${s.contentGap}px`,
    '--radius': `${s.cornerRadius}px`,
    '--sidebar-w': `${sidebarWidth}px`,
    '--content-left': `${right ? s.contentGap : side}px`,
    '--content-right': `${right ? side : s.contentGap}px`,
    '--content-top': `${right && showSidebar ? Math.max(s.contentGap, TITLEBAR_STRIP) : s.contentGap}px`,
    ...(accent ? { '--accent': accent } : {})
  } as React.CSSProperties
}

export function uiAttributes(settings: Settings): Record<string, string> {
  return {
    'data-density': settings.density,
    'data-glow': String(settings.essentialsGlow),
    'data-motion': settings.reduceMotion ? 'reduced' : 'full',
    'data-side': settings.sidebarPosition
  }
}

export function App(): React.JSX.Element | null {
  const snapshot = useSnapshot()
  const systemDark = useSystemDark()
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const [animating, setAnimating] = useState(false)
  const previous = useRef<string>('')

  // Animate the content card only for discrete layout changes, never while dragging the resize handle.
  const layoutKey = snapshot
    ? `${snapshot.compact}|${snapshot.settings.sidebarPosition}|${snapshot.settings.contentGap}|${snapshot.settings.cornerRadius}`
    : ''
  useEffect(() => {
    if (!layoutKey) return
    if (previous.current && previous.current !== layoutKey) {
      setAnimating(true)
      const timer = setTimeout(() => setAnimating(false), 320)
      previous.current = layoutKey
      return () => clearTimeout(timer)
    }
    previous.current = layoutKey
  }, [layoutKey])

  if (!snapshot) return null

  const space = snapshot.spaces.find((s) => s.id === snapshot.activeSpaceId) ?? snapshot.spaces[0]
  const dark = prefersDarkUi(space.theme, systemDark)
  const accent = themeAccent(space.theme)
  const activeTab = snapshot.tabs.find((t) => t.id === snapshot.activeTabId) ?? null
  const sidebarWidth = dragWidth ?? snapshot.sidebarWidth
  const showSidebar = !snapshot.compact && !snapshot.fullscreen

  return (
    <MotionConfig reducedMotion={snapshot.settings.reduceMotion ? 'always' : 'never'}>
      <div
        className="window"
        data-ui={dark ? 'dark' : 'light'}
        data-focused={snapshot.focused}
        data-compact={!showSidebar}
        data-animating={animating}
        {...uiAttributes(snapshot.settings)}
        style={layoutVars(snapshot, sidebarWidth, accent)}
      >
        <Background theme={space.theme} spaceKey={space.id} transparency={snapshot.settings.transparency} />
        <div className="drag-strip drag" />
        <AnimatePresence initial={false}>
          {showSidebar && (
            <motion.div
              key="sidebar"
              className="sidebar-slot"
              initial={{ x: snapshot.settings.sidebarPosition === 'right' ? 40 : -40, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: snapshot.settings.sidebarPosition === 'right' ? 40 : -40, opacity: 0, transition: { duration: 0.18 } }}
              transition={{ type: 'spring', bounce: 0, duration: 0.28 }}
            >
              <Sidebar snapshot={snapshot} width={sidebarWidth} onResize={setDragWidth} />
            </motion.div>
          )}
        </AnimatePresence>
        {snapshot.compact && !snapshot.fullscreen && snapshot.settings.compactRevealOnHover && (
          <div className="edge-hotzone" onMouseEnter={() => zepper.send({ type: 'ui.peekSidebar', show: true })} />
        )}
        {snapshot.panes.length > 1 ? (
          <SplitPanes snapshot={snapshot} />
        ) : (
          <ContentCard tab={activeTab} isPrivate={snapshot.kind === 'private'} quiet={snapshot.paletteOpen} />
        )}
        {snapshot.belowNotch && !snapshot.fullscreen && (
          <>
            <div className="notch-corner left" />
            <div className="notch-corner right" />
          </>
        )}
      </div>
    </MotionConfig>
  )
}

/** The space gradient over the window's vibrancy. */
interface BackgroundProps {
  theme: SpaceTheme
  spaceKey: string
  /** 1 shows the desktop through the window (vibrancy); 0 is a solid window. */
  transparency?: number
}

export function Background({ theme, spaceKey, transparency = 0.5 }: BackgroundProps): React.JSX.Element {
  // Up to 50% the solid base fades out to reveal the system material; past it the gradient fades too.
  const base = Math.max(0, 1 - transparency * 2)
  const gradient = transparency <= 0.5 ? 1 : 1 - (transparency - 0.5) * 1.4
  // Crossfade when switching spaces; edits within a space apply instantly so dragging feels live.
  return (
    <div className="background">
      <div className="background-base" style={{ opacity: base }} />
      <AnimatePresence initial={false}>
        <motion.div
          key={spaceKey}
          className="background-layer"
          style={{ background: themeBackground(theme), opacity: gradient }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.25 }}
        />
      </AnimatePresence>
      <div className="background-grain" style={{ backgroundImage: GRAIN, opacity: theme.texture * 0.35 }} />
    </div>
  )
}

/** Placeholder card under the web view: provides the shadow, and the empty state when no tab is open. */
function ContentCard({ tab, isPrivate, quiet }: { tab: Tab | null; isPrivate: boolean; quiet: boolean }): React.JSX.Element {
  return (
    <>
      <div className={cx('content-card', quiet && 'quiet')}>
        {!tab && isPrivate && (
          <div className="empty-state private">
            <div className="private-mark">
              <IconPrivate size={34} />
            </div>
            <div className="private-title">You're browsing privately</div>
            <p className="private-text">
              Zepper won't save your history, and this window's cookies, site data and permissions are erased when you close it. Files you
              download stay on your Mac, and ads and trackers are still blocked.
            </p>
            <div className="empty-hint">
              Press <kbd>⌘</kbd>
              <kbd>T</kbd> to search or enter an address
            </div>
          </div>
        )}
        {!tab && !isPrivate && (
          <div className="empty-state">
            <img className="empty-logo" src={logo} alt="Zepper" draggable={false} />
            <div className="empty-hint">
              Press <kbd>⌘</kbd>
              <kbd>T</kbd> to search or enter an address
            </div>
          </div>
        )}
      </div>
      <AnimatePresence>
        {tab?.loading && (
          <motion.div
            className="loading-pill"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.8 }}
            exit={{ opacity: 0, scaleX: 0.8, transition: { duration: 0.3 } }}
            transition={{ duration: 0.4 }}
          />
        )}
      </AnimatePresence>
    </>
  )
}

/** Split view: a card (shadow + focus ring) under each pane, and draggable dividers in the gaps. */
function SplitPanes({ snapshot }: { snapshot: Snapshot }): React.JSX.Element | null {
  const split = snapshot.splits.find((s) => snapshot.activeTabId && s.tabIds.includes(snapshot.activeTabId))
  const frame = useRef(0)
  if (!split) return null
  const panes = snapshot.panes
  const activeTab = snapshot.tabs.find((t) => t.id === snapshot.activeTabId)

  const sendSizes = (sizes: number[]): void => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => zepper.send({ type: 'split.resize', splitId: split.id, sizes }))
  }

  const dividers: { key: string; rect: Rect; axis: 'x' | 'y'; onMove: (pointer: number) => void }[] = []
  if (split.layout === 'grid' && panes.length >= 3) {
    const left = panes[0].rect
    const right = panes[2].rect
    const top = Math.min(left.y, right.y)
    const bottom = Math.max(panes[1].rect.y + panes[1].rect.height, right.y + right.height)
    const span = right.x + right.width - left.x - (right.x - left.x - left.width)
    dividers.push({
      key: 'grid',
      axis: 'x',
      rect: { x: left.x + left.width, y: top, width: right.x - left.x - left.width, height: bottom - top },
      onMove: (pointer) => sendSizes([Math.min(0.8, Math.max(0.2, (pointer - left.x) / span))])
    })
  } else {
    const vertical = split.layout === 'vertical'
    const first = panes[0].rect
    const last = panes[panes.length - 1].rect
    const gap = vertical ? panes[1].rect.y - first.y - first.height : panes[1].rect.x - first.x - first.width
    const start = vertical ? first.y : first.x
    const total = (vertical ? last.y + last.height : last.x + last.width) - start - gap * (panes.length - 1)
    const sum = split.sizes.reduce((a, c) => a + c, 0) || 1
    const sizes = split.sizes.length === panes.length ? split.sizes.map((v) => v / sum) : panes.map(() => 1 / panes.length)
    for (let i = 0; i < panes.length - 1; i++) {
      const a = panes[i].rect
      dividers.push({
        key: `d${i}`,
        axis: vertical ? 'y' : 'x',
        rect: vertical
          ? { x: a.x, y: a.y + a.height, width: a.width, height: gap }
          : { x: a.x + a.width, y: a.y, width: gap, height: a.height },
        onMove: (pointer) => {
          const before = sizes.slice(0, i).reduce((acc, v) => acc + v, 0)
          const pair = sizes[i] + sizes[i + 1]
          const position = (pointer - start - gap * i) / total - before
          const next = [...sizes]
          next[i] = Math.min(pair - 0.1, Math.max(0.1, position))
          next[i + 1] = pair - next[i]
          sendSizes(next)
        }
      })
    }
  }

  return (
    <>
      {panes.map((pane) => (
        <div
          key={pane.tabId}
          className={`content-card pane${pane.tabId === snapshot.activeTabId ? ' focused' : ''}`}
          style={{ left: pane.rect.x, top: pane.rect.y, width: pane.rect.width, height: pane.rect.height, right: 'auto', bottom: 'auto' }}
        />
      ))}
      {dividers.map((d) => (
        <div
          key={d.key}
          className={`split-divider-handle ${d.axis}`}
          style={{ left: d.rect.x, top: d.rect.y, width: d.rect.width, height: d.rect.height }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            e.currentTarget.dataset.dragging = 'true'
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) d.onMove(d.axis === 'x' ? e.clientX : e.clientY)
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId)
            delete e.currentTarget.dataset.dragging
          }}
        />
      ))}
      <AnimatePresence>
        {activeTab?.loading && (
          <motion.div
            className="loading-pill"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.8 }}
            exit={{ opacity: 0, transition: { duration: 0.3 } }}
          />
        )}
      </AnimatePresence>
    </>
  )
}
