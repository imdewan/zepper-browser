import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { prefersDarkUi, themeAccent, themeBackground } from '@shared/theme'
import type { Settings } from '@shared/settings'
import type { Snapshot, SpaceTheme, Tab, UiEvent } from '@shared/types'
import { zepper } from '../bridge'
import { IconBack, IconForward } from '../icons'
import { useSnapshot, useSystemDark, useUiEvents } from '../useSnapshot'
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
      <Background theme={space.theme} />
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
      <ContentCard tab={activeTab} />
      <SwipeIndicator />
    </div>
    </MotionConfig>
  )
}

/** The space gradient over the window's vibrancy, crossfading when the theme changes. */
export function Background({ theme }: { theme: SpaceTheme }): React.JSX.Element {
  const key = JSON.stringify(theme)
  return (
    <div className="background">
      <AnimatePresence initial={false}>
        <motion.div
          key={key}
          className="background-layer"
          style={{ background: themeBackground(theme) }}
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
function ContentCard({ tab }: { tab: Tab | null }): React.JSX.Element {
  return (
    <>
      <div className="content-card">
        {!tab && (
          <div className="empty-state">
            <div className="empty-logo">Zepper</div>
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

/** Back/forward arrow revealed behind the page as it slides with a two-finger swipe. */
function SwipeIndicator(): React.JSX.Element {
  const [state, setState] = useState<{ direction: 'back' | 'forward'; progress: number; allowed: boolean } | null>(null)
  useUiEvents(
    useCallback((event: UiEvent) => {
      if (event.type !== 'swipe.progress') return
      setState(event.progress > 0 ? { direction: event.direction, progress: event.progress, allowed: event.allowed } : null)
    }, [])
  )
  const armed = !!state && state.allowed && state.progress >= 1
  return (
    <AnimatePresence>
      {state && state.allowed && (
        <motion.div
          className={`swipe-indicator ${state.direction}${armed ? ' armed' : ''}`}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: Math.min(1, state.progress * 1.6), scale: 0.7 + state.progress * 0.3 }}
          exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.15 } }}
          transition={{ type: 'spring', bounce: 0.3, duration: 0.25 }}
        >
          {state.direction === 'back' ? <IconBack size={18} /> : <IconForward size={18} />}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
