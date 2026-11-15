import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { PaperSize, PrintRequest, PrintSettings, UiEvent } from '@shared/types'
import { zepper } from '../bridge'
import { useUiEvents } from '../useSnapshot'
import { cx } from '../util'
import { Toggle } from './Toggle'

const PAPER_SIZES: PaperSize[] = ['A3', 'A4', 'A5', 'Legal', 'Letter', 'Tabloid']
/** What you type (pages, copies, scale) settles this long before the preview is made again. */
const TYPING_DELAY_MS = 400

type Status = { pages: number | null; error: 'range' | 'failed' | null; ready: boolean }

/**
 * Print preview, as in Chrome: the page as it will print, with where it goes (Save as PDF or a
 * printer) and how. The preview itself is a view the main process lays over the space left for it.
 */
export function PrintPreview({ request, onCancel }: { request: PrintRequest; onCancel: () => void }): React.JSX.Element {
  const [settings, setSettings] = useState<PrintSettings>(request.settings)
  const [status, setStatus] = useState<Status>({ pages: null, error: null, ready: false })
  const [more, setMore] = useState(false)
  const [customScale, setCustomScale] = useState(request.settings.scale !== 100)
  const [scaleText, setScaleText] = useState(String(request.settings.scale))
  const [settled, setSettled] = useState(false)
  const area = useRef<HTMLDivElement>(null)
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { id } = request

  useUiEvents(
    useCallback(
      (event: UiEvent) => {
        if (event.type === 'print.rendered' && event.id === id) setStatus({ pages: event.pages, error: event.error, ready: true })
      },
      [id]
    )
  )

  const change = (patch: Partial<PrintSettings>, typed = false): void => {
    const next = { ...settings, ...patch }
    setSettings(next)
    if (typing.current) clearTimeout(typing.current)
    typing.current = null
    if (typed) typing.current = setTimeout(() => zepper.send({ type: 'print.update', id, settings: next }), TYPING_DELAY_MS)
    else zepper.send({ type: 'print.update', id, settings: next })
  }

  const pdf = settings.destination === 'pdf'
  const canSubmit = status.ready && !status.error && (!customScale || scaleOk(scaleText))
  const submit = (): void => {
    if (!canSubmit) return
    if (typing.current) clearTimeout(typing.current)
    zepper.send({ type: 'print.submit', id, settings })
  }

  // Where the preview goes, once the panel has finished opening (and whenever it changes size).
  useEffect(() => {
    const el = area.current
    if (!el || !settled) return
    const send = (): void => {
      const box = el.getBoundingClientRect()
      const rect = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
      zepper.send({ type: 'print.previewArea', id, rect })
    }
    send()
    const observer = new ResizeObserver(send)
    observer.observe(el)
    window.addEventListener('resize', send)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', send)
      zepper.send({ type: 'print.previewArea', id, rect: null })
    }
  }, [settled, id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
      else if (e.key === 'Enter' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) submit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const sheets = status.pages === null ? null : pdf ? status.pages : status.pages * Math.max(1, settings.copies || 1)
  const count =
    sheets === null ? '' : pdf ? `${sheets} ${sheets === 1 ? 'page' : 'pages'}` : `${sheets} ${sheets === 1 ? 'sheet' : 'sheets'} of paper`

  return (
    <motion.div
      className="settings-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <motion.div
        className="print"
        role="dialog"
        aria-label="Print"
        initial={{ opacity: 0, scale: 0.97, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12 } }}
        transition={{ type: 'spring', bounce: 0.12, duration: 0.4 }}
        onAnimationComplete={() => setSettled(true)}
      >
        <div className="print-preview">
          <div ref={area} className="print-preview-page">
            <p className="print-preview-note">
              {status.error === 'failed' ? 'Couldn’t make a preview of this page.' : status.ready ? '' : 'Loading preview…'}
            </p>
          </div>
        </div>

        <aside className="print-settings">
          <header className="print-header">
            <h1>Print</h1>
            <span className="print-count">{count}</span>
          </header>

          <div className="print-rows">
            <Row label="Destination">
              <select value={settings.destination} onChange={(e) => change({ destination: e.target.value })}>
                <option value="pdf">Save as PDF</option>
                {request.printers.length > 0 && (
                  <optgroup label="Printers">
                    {request.printers.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.displayName}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </Row>

            <Row label="Pages">
              <select value={settings.pages} onChange={(e) => change({ pages: e.target.value as PrintSettings['pages'] })}>
                <option value="all">All</option>
                <option value="custom">Custom</option>
              </select>
            </Row>
            {settings.pages === 'custom' && (
              <div className="print-row-under">
                <input
                  className={cx('print-input', status.error === 'range' && 'invalid')}
                  value={settings.range}
                  placeholder="e.g. 1-5, 8, 11-13"
                  autoFocus
                  onChange={(e) => change({ range: e.target.value }, true)}
                />
                {status.error === 'range' && <p className="print-error">Invalid page range, use e.g. 1-5, 8, 11-13</p>}
              </div>
            )}

            {!pdf && (
              <Row label="Copies">
                <input
                  className="print-input print-number"
                  type="number"
                  min={1}
                  max={999}
                  value={settings.copies}
                  onChange={(e) => change({ copies: Number(e.target.value) || 1 }, true)}
                />
              </Row>
            )}

            {settings.paper !== 'page' && (
              <Row label="Layout">
                <select
                  value={settings.landscape ? 'landscape' : 'portrait'}
                  onChange={(e) => change({ landscape: e.target.value === 'landscape' })}
                >
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </select>
              </Row>
            )}

            {!pdf && (
              <Row label="Colour">
                <select value={settings.color ? 'color' : 'bw'} onChange={(e) => change({ color: e.target.value === 'color' })}>
                  <option value="color">Colour</option>
                  <option value="bw">Black and white</option>
                </select>
              </Row>
            )}

            <button className={cx('print-more', more && 'open')} aria-expanded={more} onClick={() => setMore((m) => !m)}>
              More settings
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path
                  d="M2 3.5 5 6.5 8 3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            {more && (
              <>
                <Row label="Paper size">
                  <select value={settings.paper} onChange={(e) => change({ paper: e.target.value as PrintSettings['paper'] })}>
                    {/* The size the page sets for itself; other paper scales the page to fit it, as Chrome prints. */}
                    {request.pageSize && <option value="page">{`${request.pageSize} (set by the page)`}</option>}
                    {PAPER_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </Row>
                <Row label="Margins">
                  <select value={settings.margins} onChange={(e) => change({ margins: e.target.value as PrintSettings['margins'] })}>
                    <option value="default">Default</option>
                    <option value="none">None</option>
                  </select>
                </Row>
                <Row label="Scale">
                  <select
                    value={customScale ? 'custom' : 'default'}
                    onChange={(e) => {
                      const custom = e.target.value === 'custom'
                      setCustomScale(custom)
                      if (!custom) {
                        setScaleText('100')
                        change({ scale: 100 })
                      }
                    }}
                  >
                    <option value="default">Default</option>
                    <option value="custom">Custom</option>
                  </select>
                </Row>
                {customScale && (
                  <div className="print-row-under">
                    <label className="print-scale">
                      <input
                        className={cx('print-input print-number', !scaleOk(scaleText) && 'invalid')}
                        type="number"
                        min={10}
                        max={200}
                        value={scaleText}
                        autoFocus
                        onChange={(e) => {
                          setScaleText(e.target.value)
                          if (scaleOk(e.target.value)) change({ scale: Number(e.target.value) }, true)
                        }}
                      />
                      <span>%</span>
                    </label>
                    {!scaleOk(scaleText) && <p className="print-error">Use a scale from 10 to 200</p>}
                  </div>
                )}
                <div className="print-options">
                  <label className="print-option">
                    <Toggle
                      small
                      checked={settings.headersFooters && settings.margins !== 'none'}
                      disabled={settings.margins === 'none'}
                      onChange={(on) => change({ headersFooters: on })}
                    />
                    <span>Headers and footers</span>
                  </label>
                  <label className="print-option">
                    <Toggle small checked={settings.backgrounds} onChange={(on) => change({ backgrounds: on })} />
                    <span>Background graphics</span>
                  </label>
                </div>
              </>
            )}
          </div>

          <footer className="print-footer">
            <button className="print-system" onClick={() => zepper.send({ type: 'print.systemDialog', id })}>
              Print using system dialog…
              {request.systemShortcut && <span className="print-shortcut">{request.systemShortcut}</span>}
            </button>
            <div className="share-buttons">
              <button className="ob-secondary" onClick={onCancel}>
                Cancel
              </button>
              <button className="ob-primary print-submit" disabled={!canSubmit} onClick={submit}>
                {pdf ? 'Save' : 'Print'}
              </button>
            </div>
          </footer>
        </aside>
      </motion.div>
    </motion.div>
  )
}

function scaleOk(text: string): boolean {
  const value = Number(text)
  return /^\d+$/.test(text.trim()) && value >= 10 && value <= 200
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="print-row">
      <span className="print-label">{label}</span>
      <div className="print-control">{children}</div>
    </div>
  )
}
