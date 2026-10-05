import { AnimatePresence, motion } from 'motion/react'
import type { Snapshot } from '@shared/types'
import { zepper } from '../bridge'
import { Favicon } from '../Favicon'
import { Equalizer, IconClose, IconMuted, IconPause, IconPlay, IconSpeaker } from '../icons'

/**
 * Zen-style "now playing" card at the bottom of the sidebar for media in a
 * tab you're not looking at: artwork, title, play/pause, mute, and a click
 * to jump back to the tab.
 */
export function MediaCard({ snapshot }: { snapshot: Snapshot }): React.JSX.Element {
  const tab = snapshot.tabs
    .filter((t) => t.media && t.loaded && t.id !== snapshot.activeTabId)
    .sort((a, b) => Number(b.audible) - Number(a.audible) || b.lastActiveAt - a.lastActiveAt)[0]

  return (
    <AnimatePresence initial={false}>
      {tab?.media && (
        <motion.div
          key={tab.id}
          className="media-card"
          initial={{ opacity: 0, y: 10, filter: 'blur(4px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: 8, filter: 'blur(2px)', transition: { duration: 0.2 } }}
          transition={{ type: 'spring', bounce: 0.15, duration: 0.35 }}
          onClick={() => zepper.send({ type: 'tab.activate', tabId: tab.id })}
          title="Go to tab"
        >
          <div className="media-art">
            {tab.media.artwork ? <img src={tab.media.artwork} alt="" draggable={false} /> : <Favicon src={tab.favicon} size={18} />}
            {tab.audible && !tab.muted && (
              <span className="media-art-eq">
                <Equalizer />
              </span>
            )}
          </div>
          <div className="media-text">
            <div className="media-title">{tab.media.title}</div>
            <div className="media-artist">{tab.media.artist}</div>
          </div>
          <div className="media-controls" onClick={(e) => e.stopPropagation()}>
            <button
              className="media-button"
              title={tab.audible ? 'Pause' : 'Play'}
              onClick={() => zepper.send({ type: 'media.toggle', tabId: tab.id })}
            >
              {tab.audible ? <IconPause size={14} /> : <IconPlay size={14} />}
            </button>
            <button
              className="media-button"
              title={tab.muted ? 'Unmute' : 'Mute'}
              onClick={() => zepper.send({ type: 'tab.toggleMute', tabId: tab.id })}
            >
              {tab.muted ? <IconMuted size={14} /> : <IconSpeaker size={14} />}
            </button>
            <button className="media-button dismiss" title="Hide" onClick={() => zepper.send({ type: 'media.dismiss', tabId: tab.id })}>
              <IconClose size={12} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
