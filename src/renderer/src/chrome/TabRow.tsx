import { memo, useEffect, useState } from 'react'
import { motion } from 'motion/react'
import type { DropTarget, Tab } from '@shared/types'
import { zepper } from '../bridge'
import { Favicon } from '../Favicon'
import { Equalizer, IconClose, IconMinus, IconMuted, IconSpeaker } from '../icons'
import { cx, isPinnedChanged } from '../util'
import { dragProps, useDrop, type DragItem, type DropPosition } from './dnd'

/** Where a row sits, for drag and drop: its list, its position in it, and how deep in folders. */
export interface RowPlace {
  zone: 'pinned' | 'normal'
  spaceId: string
  /** Folder containing the row (pinned area only). */
  parentId: string | null
  index: number
  depth: number
}

/** The drop target for dropping before or after a row. */
export function dropBeside(place: RowPlace, position: DropPosition, item: DragItem): DropTarget | null {
  const index = position === 'after' ? place.index + 1 : place.index
  if (place.zone === 'normal') return item.kind === 'folder' ? null : { zone: 'normal', spaceId: place.spaceId, index }
  return { zone: 'pinned', spaceId: place.spaceId, parentId: place.parentId, index }
}

/** Tracks whether ⌘ is held, which switches pinned-tab reset into "separate". */
function useMetaKey(enabled: boolean): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => setHeld(e.metaKey)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
    }
  }, [enabled])
  return held
}

interface TabRowProps {
  tab: Tab
  active: boolean
  /** Set where the row can be dragged and dropped on (not in split rows). */
  place?: RowPlace
}

/** Snapshots arrive as fresh objects, so compare the fields a row actually renders. */
function sameRow(a: TabRowProps, b: TabRowProps): boolean {
  const x = a.tab
  const y = b.tab
  const p = a.place
  const q = b.place
  return (
    a.active === b.active &&
    p?.zone === q?.zone &&
    p?.spaceId === q?.spaceId &&
    p?.parentId === q?.parentId &&
    p?.index === q?.index &&
    p?.depth === q?.depth &&
    x.id === y.id &&
    x.kind === y.kind &&
    x.url === y.url &&
    x.title === y.title &&
    x.favicon === y.favicon &&
    x.loaded === y.loaded &&
    x.audible === y.audible &&
    x.muted === y.muted &&
    x.pinned?.url === y.pinned?.url &&
    x.pinned?.favicon === y.pinned?.favicon
  )
}

export const TabRow = memo(function TabRow({ tab, active, place }: TabRowProps): React.JSX.Element {
  const changed = isPinnedChanged(tab)
  const drop = useDrop({ key: `tab:${tab.id}`, target: (position, item) => (place && item.id !== tab.id ? dropBeside(place, position, item) : null) })
  const [resetHover, setResetHover] = useState(false)
  const metaHeld = useMetaKey(resetHover)

  const stop = (e: React.MouseEvent): void => e.stopPropagation()

  return (
    <motion.div
      className="tab-wrap"
      style={{ '--depth': place?.depth ?? 0 } as React.CSSProperties}
      layout="position"
      initial={{ opacity: 0, height: 0, scale: 0.95 }}
      animate={{ opacity: 1, height: 'auto', scale: 1 }}
      exit={{ opacity: 0, height: 0, scale: 0.95, transition: { duration: 0.1, ease: 'easeOut' } }}
      transition={{ duration: 0.12, ease: 'easeOut' }}
    >
      <div
        {...(place ? dragProps({ kind: 'tab', id: tab.id }) : {})}
        {...drop.props}
        className={cx('tab', active && 'active', !tab.loaded && 'unloaded', changed && 'changed', drop.position && `dnd-${drop.position}`)}
        title={tab.title || tab.url}
        onClick={() => zepper.send({ type: 'tab.activate', tabId: tab.id })}
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        onAuxClick={(e) => e.button === 1 && zepper.send({ type: 'tab.middleClick', tabId: tab.id })}
        onContextMenu={(e) => {
          e.preventDefault()
          zepper.send({ type: 'tab.contextMenu', tabId: tab.id })
        }}
      >
        {changed && tab.pinned ? (
          <button
            className={cx('pin-reset', resetHover && 'hover')}
            onMouseEnter={() => setResetHover(true)}
            onMouseLeave={() => setResetHover(false)}
            onClick={(e) => {
              stop(e)
              zepper.send({ type: 'tab.resetPinned', tabId: tab.id, separate: e.metaKey })
            }}
          >
            <Favicon src={tab.pinned.favicon} className="pin-original" />
            <Favicon src={tab.favicon} className="pin-current" />
            <span className="pin-slash" />
          </button>
        ) : (
          <Favicon src={tab.favicon} />
        )}

        <div className="tab-label">
          <span className="tab-title">{tab.title || tab.url}</span>
          {changed && (
            <span className={cx('tab-sublabel', resetHover && 'visible')}>
              {metaHeld ? 'Separate from pinned tab' : 'Back to pinned url'}
            </span>
          )}
        </div>

        {(tab.audible || tab.muted) && (
          <button
            className={cx('tab-button', 'audio', tab.muted ? 'muted' : 'playing')}
            title={tab.muted ? 'Unmute tab' : 'Mute tab'}
            onClick={(e) => {
              stop(e)
              zepper.send({ type: 'tab.toggleMute', tabId: tab.id })
            }}
          >
            {tab.muted ? (
              <IconMuted size={14} />
            ) : (
              <>
                <span className="audio-idle">
                  <Equalizer />
                </span>
                <span className="audio-hover">
                  <IconSpeaker size={14} />
                </span>
              </>
            )}
          </button>
        )}

        {tab.kind === 'normal' && (
          <button
            className="tab-button close"
            title="Close tab"
            onClick={(e) => {
              stop(e)
              zepper.send({ type: 'tab.close', tabId: tab.id })
            }}
          >
            <IconClose size={13} />
          </button>
        )}
        {tab.kind === 'pinned' && tab.loaded && (
          <button
            className="tab-button close"
            title="Unload and switch to tab"
            onClick={(e) => {
              stop(e)
              zepper.send({ type: 'tab.close', tabId: tab.id })
            }}
          >
            <IconMinus size={13} />
          </button>
        )}
      </div>
    </motion.div>
  )
}, sameRow)
