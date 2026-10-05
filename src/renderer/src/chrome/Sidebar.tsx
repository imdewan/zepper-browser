import { useCallback, useEffect, useRef, useState } from 'react'
import type { Snapshot, Tab, UiEvent } from '@shared/types'
import { zepper } from '../bridge'
import { ExtensionButton, useExtensions } from '../extensions'
import { IconBack, IconForward, IconGlobe, IconLock, IconPlus, IconPrivate, IconPuzzle, IconReload, IconSearch, IconSettings, IconSidebar } from '../icons'
import { useUiEvents } from '../useSnapshot'
import { cx, hostOf, rectOf } from '../util'
import { Essentials } from './Essentials'
import { MediaCard } from './MediaCard'
import { SpacesViewport } from './Spaces'

interface SidebarProps {
  snapshot: Snapshot
  width: number
  onResize: (width: number | null) => void
  /** Rendered in the overlay as the compact-mode peek card: no resize handle. */
  floating?: boolean
}

export function Sidebar({ snapshot, width, onResize, floating = false }: SidebarProps): React.JSX.Element {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const activeTab = snapshot.tabs.find((t) => t.id === snapshot.activeTabId) ?? null
  const essentials = snapshot.tabs.filter((t) => t.kind === 'essential')

  useUiEvents(
    useCallback((event: UiEvent) => {
      if (event.type === 'space.startRename') setRenamingId(event.spaceId)
    }, [])
  )

  return (
    <aside className="sidebar" style={{ width }}>
      <TopRow tab={activeTab} isPrivate={snapshot.kind === 'private'} />
      <UrlPill tab={activeTab} />
      <Essentials tabs={essentials} activeTabId={snapshot.activeTabId} />
      <div className="sidebar-body">
        <SpacesViewport
          snapshot={snapshot}
          renamingId={renamingId}
          onRenameDone={() => setRenamingId(null)}
          onStartRename={setRenamingId}
        />
      </div>
      {snapshot.settings.showMediaCard && <MediaCard snapshot={snapshot} />}
      <BottomBar snapshot={snapshot} />
      {!floating && <ResizeHandle width={width} side={snapshot.settings.sidebarPosition} onResize={onResize} />}
    </aside>
  )
}

function TopRow({ tab, isPrivate }: { tab: Tab | null; isPrivate: boolean }): React.JSX.Element {
  return (
    <div className="top-row drag">
      <div className="traffic-light-space" />
      <button className="icon-button compact-toggle" title="Toggle compact mode (⌘S)" onClick={() => zepper.send({ type: 'ui.toggleCompact' })}>
        <IconSidebar size={16} />
      </button>
      {isPrivate && (
        <span className="private-badge" title="Private window: history, cookies and site data are discarded when it closes">
          <IconPrivate size={13} />
          Private
        </span>
      )}
      <div className="top-row-spacer" />
      <button className="icon-button" title="Back (⌘[)" disabled={!tab?.canGoBack} onClick={() => zepper.send({ type: 'nav.back' })}>
        <IconBack size={17} />
      </button>
      <button className="icon-button forward-button" title="Forward (⌘])" disabled={!tab?.canGoForward} onClick={() => zepper.send({ type: 'nav.forward' })}>
        <IconForward size={17} />
      </button>
      <button className="icon-button" title="Reload (⌘R)" disabled={!tab} onClick={() => zepper.send({ type: 'nav.reload' })}>
        <IconReload size={16} />
      </button>
    </div>
  )
}

function UrlPill({ tab }: { tab: Tab | null }): React.JSX.Element {
  const secure = tab?.url.startsWith('https://')
  const pill = useRef<HTMLDivElement>(null)
  const openSiteInfo = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (pill.current) zepper.send({ type: 'ui.siteInfo', anchor: rectOf(pill.current) })
  }
  return (
    <div
      ref={pill}
      role="button"
      className="url-pill"
      onClick={() => zepper.send({ type: 'ui.openPalette', mode: tab ? 'current' : 'new' })}
    >
      {tab ? (
        <>
          <button className={cx('site-button', !secure && 'insecure')} title="View site information" onClick={openSiteInfo}>
            {secure ? <IconLock size={12} /> : <IconGlobe size={12} />}
          </button>
          <span className="url-pill-host">{hostOf(tab.url)}</span>
        </>
      ) : (
        <>
          <span className="site-button">
            <IconSearch size={12} />
          </span>
          <span className="url-pill-placeholder">Search or enter URL</span>
        </>
      )}
    </div>
  )
}

function BottomBar({ snapshot }: { snapshot: Snapshot }): React.JSX.Element {
  const settingsRef = useRef<HTMLButtonElement>(null)
  const newRef = useRef<HTMLButtonElement>(null)
  const extensionsRef = useRef<HTMLButtonElement>(null)
  const extensions = useExtensions()
  const pinned = snapshot.settings.pinnedExtensions.filter((id) => extensions.actions.some((a) => a.id === id))
  return (
    <div className="bottom-bar">
      <button
        ref={settingsRef}
        className="icon-button"
        title="Settings"
        onClick={() => settingsRef.current && zepper.send({ type: 'ui.settingsMenu', anchor: rectOf(settingsRef.current) })}
      >
        <IconSettings size={16} />
      </button>
      {extensions.actions.length > 0 && snapshot.kind !== 'private' && (
        <div className="bottom-extensions">
          <button
            ref={extensionsRef}
            className="icon-button"
            title="Extensions"
            onClick={() =>
              extensionsRef.current &&
              zepper.send({ type: 'ui.openPopover', popover: { kind: 'extensions', anchor: rectOf(extensionsRef.current) } })
            }
          >
            <IconPuzzle size={16} />
          </button>
          {pinned.map((id) => (
            <ExtensionButton key={id} id={id} tabId={extensions.activeTabId} version={extensions} />
          ))}
        </div>
      )}
      <SpaceSwitcher snapshot={snapshot} />
      <button
        ref={newRef}
        className="icon-button"
        title="New"
        onClick={() => newRef.current && zepper.send({ type: 'ui.newMenu', anchor: rectOf(newRef.current) })}
      >
        <IconPlus size={17} />
      </button>
    </div>
  )
}

/**
 * The space dots. Centred when they fit; when they don't, they scroll (never
 * clip), the edges with more dots fade, and the active space stays in view.
 */
function SpaceSwitcher({ snapshot }: { snapshot: Snapshot }): React.JSX.Element | null {
  const list = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState({ start: false, end: false })

  useEffect(() => {
    const el = list.current
    if (!el) return
    const update = (): void => {
      const start = el.scrollLeft > 1
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      setFade((f) => (f.start === start && f.end === end ? f : { start, end }))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    el.addEventListener('scroll', update, { passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', update)
    }
  }, [snapshot.spaces.length])

  useEffect(() => {
    list.current?.querySelector('.space-dot.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
  }, [snapshot.activeSpaceId])

  if (snapshot.spaces.length < 2) return <div className="space-switcher" />
  return (
    <div ref={list} className={cx('space-switcher', fade.start && 'fade-start', fade.end && 'fade-end')}>
      {snapshot.spaces.map((space) => (
        <button
          key={space.id}
          className={cx(
            'space-dot',
            space.id === snapshot.activeSpaceId && 'active',
            snapshot.tabs.some((t) => t.spaceId === space.id && t.audible) && 'has-audio'
          )}
          title={space.name}
          onClick={() => zepper.send({ type: 'space.switch', spaceId: space.id })}
          onContextMenu={(e) => {
            e.preventDefault()
            zepper.send({ type: 'space.contextMenu', spaceId: space.id, anchor: rectOf(e.currentTarget) })
          }}
        >
          {space.icon}
        </button>
      ))}
    </div>
  )
}

interface ResizeHandleProps {
  width: number
  side: 'left' | 'right'
  onResize: (w: number | null) => void
}

function ResizeHandle({ width, side, onResize }: ResizeHandleProps): React.JSX.Element {
  const start = useRef({ x: 0, width: 0 })
  return (
    <div
      className="resize-handle"
      onDoubleClick={() => {
        zepper.send({ type: 'ui.setSidebarWidth', width: 250 })
        onResize(null)
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, width }
        e.currentTarget.dataset.resizing = 'true'
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        const delta = (e.clientX - start.current.x) * (side === 'right' ? -1 : 1)
        const next = Math.min(500, Math.max(170, start.current.width + delta))
        onResize(next)
        zepper.send({ type: 'ui.setSidebarWidth', width: next })
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId)
        delete e.currentTarget.dataset.resizing
        onResize(null)
      }}
    />
  )
}
