import type { DownloadEntry } from '@shared/types'
import { zepper } from '../bridge'
import { IconClose, IconFolder, IconPause, IconPlay } from '../icons'
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

function status(d: DownloadEntry): string {
  switch (d.state) {
    case 'progressing': {
      const of = d.total > 0 ? `${size(d.received)} of ${size(d.total)}` : size(d.received)
      const left = timeLeft(d)
      return left ? `${of} · ${left}` : of
    }
    case 'paused':
      return `Paused · ${d.total > 0 ? `${size(d.received)} of ${size(d.total)}` : size(d.received)}`
    case 'completed':
      return `${size(d.total || d.received)} · ${hostOf(d.url)}`
    case 'cancelled':
      return 'Cancelled'
    default:
      return 'Failed'
  }
}

/** File type badge: the extension, like "PDF" or "ZIP". */
function badge(filename: string): string {
  const ext = /\.([a-z0-9]{1,4})$/i.exec(filename)?.[1]
  return ext ? ext.toUpperCase() : 'FILE'
}

const send = (id: string, action: 'open' | 'reveal' | 'pause' | 'resume' | 'cancel' | 'remove'): void =>
  zepper.send({ type: 'download.action', id, action })

/** The downloads button's panel: what's downloading and what you downloaded recently. */
export function DownloadsPanel({ downloads }: { downloads: DownloadEntry[] }): React.JSX.Element {
  const finished = downloads.some((d) => d.state !== 'progressing' && d.state !== 'paused')
  return (
    <div className="downloads-panel">
      <div className="popover-title">Downloads</div>
      {downloads.length === 0 ? (
        <p className="downloads-empty">Files you download appear here.</p>
      ) : (
        <div className="downloads-list">
          {downloads.map((d) => {
            const running = d.state === 'progressing' || d.state === 'paused'
            const done = d.state === 'completed'
            return (
              <div
                key={d.id}
                role="button"
                className={cx('download-row', done && 'done', !running && !done && 'failed')}
                title={done ? `Open ${d.filename}` : d.filename}
                onClick={() => done && send(d.id, 'open')}
              >
                <span className="download-badge">{badge(d.filename)}</span>
                <span className="download-text">
                  <span className="download-name">{d.filename}</span>
                  <span className="download-status">{status(d)}</span>
                  {running && d.total > 0 && (
                    <span className="download-bar">
                      <span style={{ width: `${Math.min(100, (d.received / d.total) * 100)}%` }} />
                    </span>
                  )}
                </span>
                <span className="download-actions" onClick={(e) => e.stopPropagation()}>
                  {running && (
                    <button
                      className="download-action"
                      title={d.state === 'paused' ? 'Resume' : 'Pause'}
                      onClick={() => send(d.id, d.state === 'paused' ? 'resume' : 'pause')}
                    >
                      {d.state === 'paused' ? <IconPlay size={12} /> : <IconPause size={12} />}
                    </button>
                  )}
                  {done && (
                    <button className="download-action" title="Show in Finder" onClick={() => send(d.id, 'reveal')}>
                      <IconFolder size={14} />
                    </button>
                  )}
                  <button
                    className="download-action"
                    title={running ? 'Cancel' : 'Remove from list'}
                    onClick={() => send(d.id, running ? 'cancel' : 'remove')}
                  >
                    <IconClose size={11} />
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      )}
      {finished && (
        <button className="downloads-clear" onClick={() => zepper.send({ type: 'downloads.clear' })}>
          Clear list
        </button>
      )}
    </div>
  )
}
