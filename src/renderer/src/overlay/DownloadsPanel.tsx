import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import type { Command, DownloadEntry } from '@shared/types'
import { zepper } from '../bridge'
import { IconClose, IconDownload, IconFolder, IconPause, IconPlay, IconTrash } from '../icons'
import { cx, hostOf } from '../util'

const units = ['B', 'KB', 'MB', 'GB']

function size(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function timeLeft(d: DownloadEntry): string | null {
  const elapsed = (Date.now() - d.startedAt) / 1000
  if (d.total <= 0 || d.received <= 0 || elapsed < 2) return null
  const seconds = (d.total - d.received) / (d.received / elapsed)
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s left`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`
  return `${Math.round(seconds / 3600)} h left`
}

/** File type badge: the extension, like "PDF" or "ZIP". */
function badge(filename: string): string {
  const ext = /\.([a-z0-9]{1,4})$/i.exec(filename)?.[1]
  return ext ? ext.toUpperCase() : 'FILE'
}

const send = (id: string, action: Extract<Command, { type: 'download.action' }>['action']): void =>
  zepper.send({ type: 'download.action', id, action })

/** "Just now", "5 min ago", "3 h ago", then the date. */
function ago(at: number): string {
  const seconds = (Date.now() - at) / 1000
  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 6 * 3600) return `${Math.floor(seconds / 3600)} h ago`
  return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** Which day group a download belongs to. */
function day(at: number): 'Today' | 'Yesterday' | 'Earlier' {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  if (at >= start.getTime()) return 'Today'
  if (at >= start.getTime() - 86_400_000) return 'Yesterday'
  return 'Earlier'
}

/** The second line under a download's name. */
function detail(d: DownloadEntry): string {
  const site = d.site || hostOf(d.url)
  const of = d.total > 0 ? `${size(d.received)} of ${size(d.total)}` : size(d.received)
  switch (d.state) {
    case 'progressing': {
      const left = timeLeft(d)
      return left ? `${of} · ${left}` : of
    }
    case 'paused':
      return `Paused · ${of}`
    case 'completed':
      return [size(d.total || d.received), site, ago(d.startedAt)].filter(Boolean).join(' · ')
    case 'cancelled':
      return ['Cancelled', site].filter(Boolean).join(' · ')
    default:
      return ['Failed', site].filter(Boolean).join(' · ')
  }
}

/** A download's file icon, as Finder shows it (the kind of file's badge until it arrives). */
function FileIcon({ download }: { download: DownloadEntry }): React.JSX.Element {
  const [icon, setIcon] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void zepper.downloadIcon(download.id).then((url) => live && setIcon(url))
    return () => {
      live = false
    }
  }, [download.id])
  return icon ? (
    <img className="download-icon" src={icon} alt="" draggable={false} />
  ) : (
    <span className="download-badge">{badge(download.filename)}</span>
  )
}

/**
 * Downloads (⌥⌘L or the bottom bar's button): what's downloading at the top, then what you
 * downloaded, newest first by day, each with its file icon, size, site and when. A finished one
 * opens with a click and drags out as the file (onto a page to upload it, the tabs, or Finder).
 */
export function DownloadsPanel({ downloads, onClose }: { downloads: DownloadEntry[]; onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const running = (d: DownloadEntry): boolean => d.state === 'progressing' || d.state === 'paused'
  const newest = [...downloads].sort((a, b) => b.startedAt - a.startedAt)
  const groups: { label: string; items: DownloadEntry[] }[] = []
  const add = (label: string, item: DownloadEntry): void => {
    const group = groups.find((g) => g.label === label)
    if (group) group.items.push(item)
    else groups.push({ label, items: [item] })
  }
  for (const d of newest) add(running(d) ? 'Downloading' : day(d.startedAt), d)
  const order = ['Downloading', 'Today', 'Yesterday', 'Earlier']
  groups.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label))
  return (
    <motion.div
      className="settings-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        className="downloads-panel"
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.15 } }}
        transition={{ type: 'spring', bounce: 0.12, duration: 0.35 }}
      >
        <header className="downloads-header">
          <h2>Downloads</h2>
          <button
            className="downloads-folder"
            title="Open the Downloads folder"
            onClick={() => zepper.send({ type: 'downloads.openFolder' })}
          >
            <IconFolder size={14} />
            Show in Finder
          </button>
          <button className="settings-close" title="Close (Esc)" onClick={onClose}>
            <IconClose size={14} />
          </button>
        </header>
        {downloads.length === 0 ? (
          <div className="downloads-empty">
            <span className="downloads-empty-icon">
              <IconDownload size={20} />
            </span>
            <span className="downloads-empty-title">No downloads yet</span>
            <span className="downloads-empty-hint">Files you download show up here, with where they came from.</span>
          </div>
        ) : (
          <div className="downloads-list">
            {groups.map((group) => (
              <section key={group.label} className="downloads-group">
                <h3>{group.label}</h3>
                {group.items.map((d) => {
                  const live = running(d)
                  const done = d.state === 'completed'
                  return (
                    <div
                      key={d.id}
                      role="button"
                      className={cx('download-row', done && 'done', !live && !done && 'failed')}
                      title={done ? `Open ${d.filename}, or drag it onto a page or a tab` : d.filename}
                      onClick={() => done && send(d.id, 'open')}
                      // A finished download drags out as the file itself: onto a page to upload it, onto
                      // the tabs to open it, or into Finder. The panel steps aside so the drop lands there.
                      draggable={done}
                      onDragStart={(e) => {
                        e.preventDefault()
                        zepper.send({ type: 'download.drag', id: d.id })
                        onClose()
                      }}
                    >
                      <FileIcon download={d} />
                      <span className="download-text">
                        <span className="download-name">{d.filename}</span>
                        {live && d.total > 0 && (
                          <span className={cx('download-bar', d.state === 'paused' && 'paused')}>
                            <span style={{ width: `${Math.min(100, (d.received / d.total) * 100)}%` }} />
                          </span>
                        )}
                        <span className="download-status">{detail(d)}</span>
                      </span>
                      <span className="download-actions" onClick={(e) => e.stopPropagation()}>
                        {live && (
                          <button
                            className="download-action"
                            title={d.state === 'paused' ? 'Resume' : 'Pause'}
                            onClick={() => send(d.id, d.state === 'paused' ? 'resume' : 'pause')}
                          >
                            {d.state === 'paused' ? <IconPlay size={12} /> : <IconPause size={12} />}
                          </button>
                        )}
                        {live && (
                          <button className="download-action" title="Cancel" onClick={() => send(d.id, 'cancel')}>
                            <IconClose size={11} />
                          </button>
                        )}
                        {done && (
                          <button className="download-action" title="Show in Finder" onClick={() => send(d.id, 'reveal')}>
                            <IconFolder size={14} />
                          </button>
                        )}
                        {done && (
                          <button className="download-action delete" title="Move to Trash" onClick={() => send(d.id, 'trash')}>
                            <IconTrash size={13} />
                          </button>
                        )}
                      </span>
                    </div>
                  )
                })}
              </section>
            ))}
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}
