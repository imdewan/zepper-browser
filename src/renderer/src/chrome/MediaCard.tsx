import { AnimatePresence, motion } from 'motion/react'
import type { Snapshot, Tab } from '@shared/types'
import { zepper } from '../bridge'
import { Favicon } from '../Favicon'
import { Equalizer, IconClose, IconMuted, IconPause, IconPlay, IconSpeaker } from '../icons'

const byRecent = (a: Tab, b: Tab): number => b.audibleAt - a.audibleAt || b.lastActiveAt - a.lastActiveAt

/**
 * Which tab the card shows. It follows the media you most recently played:
 * - something playing in a tab you can't see wins, newest first;
 * - if what's playing is on screen (active tab or a split pane), the card
 *   steps aside rather than showing an older paused tab;
 * - with nothing playing, the most recently played (now paused) tab stays,
 *   unless it's the one on screen.
 */
function nowPlaying(snapshot: Snapshot): Tab | undefined {
  const inView = new Set([snapshot.activeTabId, ...snapshot.panes.map((p) => p.tabId)])
  const withMedia = snapshot.tabs.filter((t) => t.media && t.loaded)
  const playingHidden = withMedia.filter((t) => t.audible && !inView.has(t.id)).sort(byRecent)
  if (playingHidden.length > 0) return playingHidden[0]
  if (snapshot.tabs.some((t) => t.audible && inView.has(t.id))) return undefined
  const recent = [...withMedia].sort(byRecent)[0]
  return recent && !inView.has(recent.id) ? recent : undefined
}

/**
 * Zen-style "now playing" card at the bottom of the sidebar for media in a
 * tab you're not looking at: artwork, title, play/pause, mute, and a click
 * to jump back to the tab.
 */
export function MediaCard({ snapshot }: { snapshot: Snapshot }): React.JSX.Element {
  const tab = nowPlaying(snapshot)
  const playing = snapshot.tabs.filter((t) => t.audible && !t.muted)
  const newest = [...playing].sort(byRecent)[0]

  return (
    <>
      <AnimatePresence initial={false}>
        {playing.length > 1 && newest && (
          <motion.div
            key="others"
            className="media-others"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0, transition: { duration: 0.15 } }}
            transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
          >
            <span className="media-others-label">
              <Equalizer />
              <span className="media-others-text">{playing.length} playing</span>
            </span>
            <button
              className="media-others-button"
              title={`Keep "${newest.media?.title || newest.title}" and pause the rest`}
              onClick={() => zepper.send({ type: 'media.pauseOthers', keepTabId: newest.id })}
            >
              Pause others
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {tab?.media && (
          <motion.div
            key={tab.id}
            className="media-card"
            initial={{ opacity: 0, y: 10, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{
              opacity: 0,
              y: 8,
              filter: 'blur(2px)',
              transition: { duration: 0.2 }
            }}
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
                className="media-button mute"
                title={tab.muted ? 'Unmute' : 'Mute'}
                onClick={() => zepper.send({ type: 'tab.toggleMute', tabId: tab.id })}
              >
                {tab.muted ? <IconMuted size={14} /> : <IconSpeaker size={14} />}
              </button>
              <button className="media-button dismiss" title="Hide" onClick={() => zepper.send({ type: 'media.dismiss', tabId: tab.id })}>
                <IconClose size={11} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
