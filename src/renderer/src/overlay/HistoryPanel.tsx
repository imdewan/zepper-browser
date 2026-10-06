import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { HistoryEntry } from '@shared/types'
import { zepper } from '../bridge'
import { Favicon } from '../Favicon'
import { IconClose, IconSearch, IconSparkle } from '../icons'
import { hostOf } from '../util'

const DAY = 86_400_000
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function dayLabel(time: number): string {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (time >= today.getTime()) return 'Today'
  if (time >= today.getTime() - DAY) return 'Yesterday'
  return dayFormat.format(time)
}

/** ⌘Y: everything you've visited, newest first, grouped by day, searchable. */
export function HistoryPanel({ meaning, onClose }: { meaning: boolean; onClose: () => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  // Matches by meaning (on-device), for queries of a few words: "that article about…".
  const [matches, setMatches] = useState<{ query: string; entries: HistoryEntry[] } | null>(null)
  const meaningRequest = useRef(0)
  const byMeaning = meaning && query.trim().split(/\s+/).length >= 2
  const [clearing, setClearing] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const request = useRef(0)

  const load = (text: string): void => {
    const id = ++request.current
    void zepper.history(text).then((list) => {
      if (id === request.current) setEntries(list)
    })
  }

  useEffect(() => {
    input.current?.focus()
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => load(query), query ? 120 : 0)
    return () => clearTimeout(timer)
  }, [query])
  useEffect(() => {
    if (!byMeaning) return
    const id = ++meaningRequest.current
    const text = query.trim()
    const timer = setTimeout(() => {
      void zepper.historyMeaning(text).then((list) => {
        if (id === meaningRequest.current) setMatches({ query: text, entries: list })
      })
    }, 450)
    return () => clearTimeout(timer)
  }, [query, byMeaning])
  const shownMatches = byMeaning && matches?.query === query.trim() ? matches.entries : null
  const searchingMeaning = byMeaning && matches?.query !== query.trim()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const groups = useMemo(() => {
    const byDay: { label: string; items: HistoryEntry[] }[] = []
    for (const entry of entries ?? []) {
      const label = dayLabel(entry.lastVisit)
      const group = byDay[byDay.length - 1]
      if (group?.label === label) group.items.push(entry)
      else byDay.push({ label, items: [entry] })
    }
    return byDay
  }, [entries])

  const open = (url: string): void => {
    zepper.send({ type: 'tab.open', input: url, where: 'new' })
    onClose()
  }
  const remove = (url: string): void => {
    zepper.send({ type: 'history.remove', url })
    setEntries((list) => list?.filter((e) => e.url !== url) ?? null)
  }
  const clear = (since: number): void => {
    zepper.send({ type: 'history.clear', since })
    setClearing(false)
    setEntries((list) => list?.filter((e) => e.lastVisit < since) ?? null)
  }

  return (
    <motion.div
      className="settings-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        className="history"
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.15 } }}
        transition={{ type: 'spring', bounce: 0.12, duration: 0.35 }}
      >
        <header className="history-header">
          <h2>History</h2>
          <div className="history-clear">
            <button className="panel-button" onClick={() => setClearing((c) => !c)}>
              Clear…
            </button>
            {clearing && (
              <div className="history-clear-menu">
                <button onClick={() => clear(Date.now() - 60 * 60 * 1000)}>Last hour</button>
                <button onClick={() => clear(new Date().setHours(0, 0, 0, 0))}>Today</button>
                <button className="danger" onClick={() => clear(0)}>
                  All history
                </button>
              </div>
            )}
          </div>
          <button className="settings-close" title="Close (Esc)" onClick={onClose}>
            <IconClose size={14} />
          </button>
        </header>
        <label className="history-search">
          <IconSearch size={15} />
          <input
            ref={input}
            value={query}
            spellCheck={false}
            placeholder={meaning ? 'Search history, or describe what you remember' : 'Search history'}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="history-list">
          {(searchingMeaning || (shownMatches && shownMatches.length > 0)) && (
            <section className="history-meaning">
              <h3 className="history-day">
                <IconSparkle size={11} /> Best matches
              </h3>
              {searchingMeaning && <p className="history-searching">Searching by meaning…</p>}
              {shownMatches?.map((entry) => (
                <div key={entry.url} role="button" className="history-row" title={entry.url} onClick={() => open(entry.url)}>
                  <span className="history-time">
                    {dayLabel(entry.lastVisit) === 'Today' ? timeFormat.format(entry.lastVisit) : dayLabel(entry.lastVisit).split(',')[0]}
                  </span>
                  <Favicon src={null} size={16} />
                  <span className="history-title">{entry.title || entry.url}</span>
                  <span className="history-host">{hostOf(entry.url)}</span>
                </div>
              ))}
            </section>
          )}
          {entries !== null && entries.length === 0 && !(shownMatches && shownMatches.length > 0) && !searchingMeaning && (
            <p className="history-empty">{query ? 'Nothing matches that.' : 'Pages you visit will show up here.'}</p>
          )}
          {groups.map((group) => (
            <section key={group.label}>
              <h3 className="history-day">{group.label}</h3>
              {group.items.map((entry) => (
                <div key={entry.url} role="button" className="history-row" title={entry.url} onClick={() => open(entry.url)}>
                  <span className="history-time">{timeFormat.format(entry.lastVisit)}</span>
                  <Favicon src={null} size={16} />
                  <span className="history-title">{entry.title || entry.url}</span>
                  <span className="history-host">{hostOf(entry.url)}</span>
                  <button
                    className="history-remove"
                    title="Remove from history"
                    onClick={(e) => {
                      e.stopPropagation()
                      remove(entry.url)
                    }}
                  >
                    <IconClose size={10} />
                  </button>
                </div>
              ))}
            </section>
          ))}
        </div>
      </motion.div>
    </motion.div>
  )
}
