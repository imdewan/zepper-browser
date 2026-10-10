import { memo, useEffect, useState } from 'react'
import { motion } from 'motion/react'
import type { CaptureState, DropTarget, Tab } from '@shared/types'
import { zepper } from '../bridge'
import { Favicon } from '../Favicon'
import { Equalizer, IconCamera, IconClose, IconMic, IconMinus, IconMuted, IconScreenShare, IconSpeaker } from '../icons'
import { cx, isPinnedChanged, primaryKey } from '../util'
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

/** Tracks whether ⌘ (Ctrl on Linux) is held, which switches pinned-tab reset into "separate". */
function useMetaKey(enabled: boolean): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => setHeld(primaryKey(e))
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
    x.discarded === y.discarded &&
    x.audible === y.audible &&
    x.muted === y.muted &&
    x.capture?.camera === y.capture?.camera &&
    x.capture?.microphone === y.capture?.microphone &&
    x.capture?.screen === y.capture?.screen &&
    x.capture?.call === y.capture?.call &&
    x.pinned?.url === y.pinned?.url &&
    x.pinned?.favicon === y.pinned?.favicon &&
    x.developing === y.developing
  )
}

export const TabRow = memo(function TabRow({ tab, active, place }: TabRowProps): React.JSX.Element {
  const changed = isPinnedChanged(tab)
  const drop = useDrop({
    key: `tab:${tab.id}`,
    target: (position, item) => (place && item.id !== tab.id ? dropBeside(place, position, item) : null),
    onto: tab.id
  })
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
        className={cx(
          'tab',
          active && 'active',
          !tab.loaded && 'unloaded',
          changed && 'changed',
          // A site you're building (Developer Mode): outlined like caution tape, as in Arc.
          tab.developing && 'developing',
          drop.position && `dnd-${drop.position}`
        )}
        title={tab.title || tab.url}
        onClick={() => zepper.send({ type: 'tab.activate', tabId: tab.id })}
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        onAuxClick={(e) => e.button === 1 && zepper.send({ type: 'tab.middleClick', tabId: tab.id })}
        onContextMenu={(e) => {
          e.preventDefault()
          zepper.send({ type: 'tab.contextMenu', tabId: tab.id })
        }}
      >
        {/* A site you're building (Developer Mode), on the tab you're on: hazard-tape edges, as in Arc. */}
        {tab.developing && active && <span className="dev-outline" aria-hidden="true" />}
        {changed && tab.pinned ? (
          <button
            className={cx('pin-reset', resetHover && 'hover')}
            onMouseEnter={() => setResetHover(true)}
            onMouseLeave={() => setResetHover(false)}
            onClick={(e) => {
              stop(e)
              zepper.send({ type: 'tab.resetPinned', tabId: tab.id, separate: primaryKey(e) })
            }}
          >
            <Favicon src={tab.pinned.favicon} className="pin-original" />
            <Favicon src={tab.favicon} className="pin-current" />
            <span className="pin-slash" />
          </button>
        ) : !tab.loaded && tab.discarded ? (
          <InactiveFavicon src={tab.favicon} />
        ) : (
          <Favicon src={tab.favicon} />
        )}

        <div className="tab-label">
          <span className="tab-title">{tab.title || tab.url}</span>
          {/* Its address under the title (localhost:3000), as Arc shows it. */}
          {tab.developing && active && !changed && <span className="tab-devhost">{devHost(tab.url)}</span>}
          {changed && (
            <span className={cx('tab-sublabel', resetHover && 'visible')}>
              {metaHeld ? 'Separate from pinned tab' : 'Back to pinned url'}
            </span>
          )}
        </div>

        {tab.capture && (tab.capture.camera || tab.capture.microphone || tab.capture.screen) && <CaptureIndicator capture={tab.capture} />}

        {((tab.audible && !tab.capture) || tab.muted) && (
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

/**
 * What a tab is using, in macOS's colours: camera green, microphone orange, screen purple. Camera and
 * microphone together are one camera icon (as macOS shows one green dot), so a tab has two at most.
 */
export function CaptureIndicator({ capture }: { capture: CaptureState }): React.JSX.Element {
  const using = [capture.camera && 'camera', capture.microphone && 'microphone', capture.screen && 'screen'].filter(Boolean)
  const what = using.length > 1 ? `${using.slice(0, -1).join(', ')} and ${using[using.length - 1]}` : using[0]
  return (
    <span className="tab-capture" title={`Using your ${what}`} role="img" aria-label={`Using your ${what}`}>
      {capture.camera && <IconCamera size={11} className="capture-camera" />}
      {capture.microphone && !capture.camera && <IconMic size={11} className="capture-microphone" />}
      {capture.screen && <IconScreenShare size={11} className="capture-screen" />}
    </span>
  )
}

/**
 * The ring Chromium draws around an inactive (not loaded) tab's icon, as Chrome and Brave show Memory
 * Saver tabs: a long arc on the left and four short dashes (dotted_icon.cc), fading in over a second,
 * with the icon cropped to a circle inside it.
 */
const INACTIVE_RING =
  'M8.44 18.86A9 9 0 0 1 8.44 1.14M11.56 1.14A9 9 0 0 1 15.16 2.63M17.37 4.84A9 9 0 0 1 18.86 8.44M18.86 11.56A9 9 0 0 1 17.37 15.16M15.16 17.37A9 9 0 0 1 11.56 18.86'

function InactiveFavicon({ src }: { src: string | null }): React.JSX.Element {
  return (
    <span className="tab-inactive" title="Inactive tab: it loads when you open it">
      <Favicon src={src} />
      <svg className="tab-inactive-ring" viewBox="0 0 20 20" aria-hidden="true">
        <path d={INACTIVE_RING} />
      </svg>
    </span>
  )
}

/** The host and port a site you're building is on ("localhost:3000"). */
function devHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
