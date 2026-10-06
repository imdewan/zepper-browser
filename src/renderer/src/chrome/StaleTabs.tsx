import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import type { Space, Tab } from '@shared/types'
import { zepper } from '../bridge'
import { Favicon } from '../Favicon'
import { IconClose, IconFolder } from '../icons'

const DAY = 86_400_000

/** The time, refreshed every minute (for "not opened in 3 days"). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

interface StaleTabsProps {
  space: Space
  /** The space's normal tabs. */
  tabs: Tab[]
  activeTabId: string | null
  /** Busy tabs (split view, playing) are never suggested. */
  busy: Set<string>
  days: number
}

/** "6 tabs you haven't opened in 3 days": close them, set them aside in a folder, or not now. */
export function StaleTabs({ space, tabs, activeTabId, busy, days }: StaleTabsProps): React.JSX.Element | null {
  const now = useNow()
  if (days <= 0) return null
  // Dismissed: quiet for a day.
  if (space.staleDismissedAt && now - space.staleDismissedAt < DAY) return null
  const stale = tabs.filter((t) => t.id !== activeTabId && !t.audible && !busy.has(t.id) && now - t.lastActiveAt > days * DAY)
  if (stale.length < 2) return null
  const ids = stale.map((t) => t.id)
  return (
    <motion.div
      className="stale-tabs"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.18 }}
    >
      <div className="stale-tabs-head">
        <div className="stale-tabs-icons">
          {stale.slice(0, 4).map((tab) => (
            <Favicon key={tab.id} src={tab.favicon} size={14} />
          ))}
        </div>
        <div className="stale-tabs-text">
          {stale.length} tabs you haven’t opened in{' '}
          {days === 1 ? 'a day' : days === 7 ? 'a week' : days === 14 ? 'two weeks' : `${days} days`}
        </div>
        <button
          className="stale-tabs-dismiss"
          title="Not now"
          onClick={() => zepper.send({ type: 'space.dismissStale', spaceId: space.id })}
        >
          <IconClose size={10} />
        </button>
      </div>
      <div className="stale-tabs-actions">
        <button onClick={() => zepper.send({ type: 'tabs.closeStale', spaceId: space.id, tabIds: ids })}>Close them</button>
        <button onClick={() => zepper.send({ type: 'tabs.folderStale', spaceId: space.id, tabIds: ids })}>
          <IconFolder size={12} />
          Put in a folder
        </button>
      </div>
    </motion.div>
  )
}
