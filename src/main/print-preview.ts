import { WebContentsView, app, dialog, type BrowserWindow, type WebContents, type WebContentsPrintOptions } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PrintSettings, Rect, UiEvent } from '@shared/types'
import { JsonFile } from './persist'
import {
  countPdfPages,
  defaultPrintSettings,
  pageSizeLabel,
  parsePageRanges,
  pdfOptions,
  printerOptions,
  stickySettings,
  validScale,
  type PageRanges
} from './print-options'

/** As in Chrome: the page hears it's being printed when the preview opens, and that it's done when it closes. */
const BEFORE_PRINT_SCRIPT = `(() => { window.dispatchEvent(new Event('beforeprint')); return document.title })()`
const AFTER_PRINT_SCRIPT = `window.dispatchEvent(new Event('afterprint'))`

/** The paper size the page sets for itself (CSS @page size), from any stylesheet it can read; '' for none. */
const PAGE_SIZE_SCRIPT = `(() => {
  const size = (rules) => {
    for (const rule of rules) {
      const found = rule instanceof CSSPageRule ? rule.style.getPropertyValue('size').trim() : rule.cssRules ? size(rule.cssRules) : ''
      if (found) return found
    }
    return ''
  }
  for (const sheet of document.styleSheets) {
    try {
      const found = size(sheet.cssRules)
      if (found) return found
    } catch {
      // Another site's stylesheet, which the page can't read.
    }
  }
  return ''
})()`

/** How long choices settle before the preview is made again. */
const RENDER_DELAY_MS = 150

let stickyFile: JsonFile<Partial<PrintSettings>> | null = null
let lastSticky: Partial<PrintSettings> | null = null

/** The choices kept from the last print (in memory once read, since saving is delayed). */
function readSticky(): Partial<PrintSettings> | null {
  stickyFile ??= new JsonFile<Partial<PrintSettings>>('print-settings.json', 500)
  lastSticky ??= stickyFile.read()
  return lastSticky
}

function saveSticky(settings: PrintSettings): void {
  const { destination, landscape, color, margins, scale, headersFooters, backgrounds } = settings
  // A page's own size is that page's, so the paper you last chose stays as it was.
  const paper = settings.paper === 'page' ? readSticky()?.paper : settings.paper
  lastSticky = { destination, landscape, color, paper, margins, scale, headersFooters, backgrounds }
  stickyFile ??= new JsonFile<Partial<PrintSettings>>('print-settings.json', 500)
  stickyFile.schedule(lastSticky)
}

export interface PrintHost {
  win: BrowserWindow
  emit(event: UiEvent): void
  /** Puts the preview on screen, above the overlay (again, to bring it back on top). */
  attach(view: WebContentsView): void
  detach(view: WebContentsView): void
  /** The preview closed. `fromPanel`: the panel closed itself (cancelled), so the overlay has already let go. */
  closed(preview: PrintPreview, fromPanel: boolean): void
  /** Where Save as PDF suggests saving a page with this title. */
  pdfPath(title: string): string
  toast(message: string, description: string): void
  systemDialog(page: WebContents): void
  print(page: WebContents, options: WebContentsPrintOptions): void
  systemShortcut(): string | null
}

let nextId = 1

/**
 * Chrome's print preview, which Electron doesn't have: the page as a PDF, made again as you change the
 * choices, to save or send to a printer. The panel's controls are in the overlay; the preview is the
 * PDF in a view of its own, placed where the panel leaves room for it.
 */
export class PrintPreview {
  readonly id = nextId++
  private readonly view: WebContentsView
  private settings: PrintSettings
  /** The size the page sets for itself, as the panel shows it (null: none). */
  private pageSize: string | null = null
  private title = ''
  private area: Rect | null = null
  private attached = false
  private loaded = false
  /** The latest preview, the choices it was made with, and the pages it has (custom pages). */
  private pdf: Buffer | null = null
  private pdfSettings: string | null = null
  private ranges: PageRanges | undefined
  private seq = 0
  /** One PDF at a time: a page can't be printed twice at once. */
  private queue: Promise<void> = Promise.resolve()
  private timer: NodeJS.Timeout | null = null
  private files: string[] = []
  private done = false
  private readonly dir = join(app.getPath('temp'), 'zepper-print')
  private readonly onPageGone = (): void => this.close()
  private readonly onPageNavigates = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
    if (details.isMainFrame && !details.isSameDocument) this.close()
  }

  constructor(
    readonly page: WebContents,
    private readonly host: PrintHost
  ) {
    this.settings = defaultPrintSettings(app.getLocaleCountryCode())
    this.view = new WebContentsView({ webPreferences: { session: page.session, sandbox: true, contextIsolation: true, plugins: true } })
    this.view.setBorderRadius(10)
    const wc = this.view.webContents
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    // Links in the PDF don't go anywhere from here.
    wc.on('will-navigate', (event) => event.preventDefault())
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      if (input.key === 'Escape') {
        event.preventDefault()
        this.cancel()
      } else if ((input.meta || input.control) && input.key.toLowerCase() === 'p') {
        // The PDF viewer's own Print would open the system dialog over this one.
        event.preventDefault()
      }
    })
    wc.on('did-finish-load', () => {
      this.loaded = true
      this.place()
      // The previews before this one are no longer shown.
      for (const file of this.files.splice(0, this.files.length - 1)) void rm(file, { force: true })
    })
    page.once('destroyed', this.onPageGone)
    page.on('did-start-navigation', this.onPageNavigates)
  }

  async open(): Promise<void> {
    const [title, pageSize, printers] = await Promise.all([
      this.page.executeJavaScript(BEFORE_PRINT_SCRIPT).catch(() => ''),
      this.page.executeJavaScript(PAGE_SIZE_SCRIPT).catch(() => ''),
      this.page.getPrintersAsync().catch(() => [])
    ])
    if (this.done) return
    // The title the page gave itself for printing names the PDF (an invoice's number, say).
    this.title = typeof title === 'string' && title.trim() ? title.trim() : this.page.getTitle()
    this.pageSize = typeof pageSize === 'string' ? pageSizeLabel(pageSize) : null
    this.settings = stickySettings(readSticky(), defaultPrintSettings(app.getLocaleCountryCode()))
    // A page that sets its own size prints on it, unless you choose other paper.
    if (this.pageSize) this.settings.paper = 'page'
    // A printer that's no longer there: back to Save as PDF.
    if (this.settings.destination !== 'pdf' && !printers.some((p) => p.name === this.settings.destination)) {
      this.settings.destination = 'pdf'
    }
    this.host.emit({
      type: 'print.open',
      request: {
        id: this.id,
        printers: printers.map((p) => ({ name: p.name, displayName: p.displayName || p.name })),
        settings: this.settings,
        pageSize: this.pageSize,
        systemShortcut: this.host.systemShortcut()
      }
    })
    void this.render()
  }

  update(settings: PrintSettings): void {
    if (this.done) return
    this.settings = clean(settings, this.settings, this.pageSize)
    saveSticky(this.settings)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.render()
    }, RENDER_DELAY_MS)
  }

  /** Where the panel leaves room for the preview (null: nowhere, while it's opening or closing). */
  setArea(rect: Rect | null): void {
    this.area = rect
    this.place()
  }

  /** Back on top after the window's views were put in order again. */
  raise(): void {
    if (this.attached) this.host.attach(this.view)
  }

  async submit(settings: PrintSettings): Promise<void> {
    if (this.done) return
    this.settings = clean(settings, this.settings, this.pageSize)
    saveSticky(this.settings)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.pdfSettings !== JSON.stringify(this.settings)) await this.render()
    // Never a PDF of earlier choices (they changed again while this one was being made).
    if (this.done || !this.pdf || this.pdfSettings !== JSON.stringify(this.settings)) return
    if (this.settings.destination !== 'pdf') {
      this.host.print(this.page, printerOptions(this.settings, this.ranges, this.title, this.page.getURL()))
      return this.close()
    }
    const pdf = this.pdf
    const { canceled, filePath } = await dialog.showSaveDialog(this.host.win, {
      defaultPath: this.host.pdfPath(this.title),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    // Cancelled: the preview stays, as it was.
    if (canceled || !filePath || this.done) return
    try {
      await writeFile(filePath, pdf)
      this.host.toast('Saved as PDF', basename(filePath))
      this.close()
    } catch {
      this.host.toast('Couldn’t save the PDF', basename(filePath))
    }
  }

  cancel(fromPanel = false): void {
    this.close(fromPanel)
  }

  /** Print using system dialog… instead. */
  systemDialog(): void {
    const page = this.page
    this.close()
    if (!page.isDestroyed()) this.host.systemDialog(page)
  }

  close(fromPanel = false): void {
    if (this.done) return
    this.done = true
    this.seq++
    if (this.timer) clearTimeout(this.timer)
    this.page.off('destroyed', this.onPageGone)
    this.page.off('did-start-navigation', this.onPageNavigates)
    if (this.attached) this.host.detach(this.view)
    this.attached = false
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close()
    if (!this.page.isDestroyed()) void this.page.executeJavaScript(AFTER_PRINT_SCRIPT).catch(() => {})
    for (const file of this.files.splice(0)) void rm(file, { force: true })
    if (!fromPanel) this.host.emit({ type: 'print.close', id: this.id })
    this.host.closed(this, fromPanel)
  }

  /** Makes the PDF for the current choices and shows it, once any being made is done (and not if newer choices came). */
  private render(): Promise<void> {
    const seq = ++this.seq
    this.queue = this.queue.then(() => (seq === this.seq ? this.renderNow(seq) : undefined))
    return this.queue
  }

  /** With custom pages, they're checked against the page count first. */
  private async renderNow(seq: number): Promise<void> {
    const settings = this.settings
    try {
      let pdf = await this.page.printToPDF(pdfOptions(settings))
      if (seq !== this.seq) return
      let ranges: PageRanges | undefined
      if (settings.pages === 'custom') {
        const parsed = parsePageRanges(settings.range, countPdfPages(pdf) ?? undefined)
        if (!parsed) {
          this.pdf = null
          this.pdfSettings = null
          this.host.emit({ type: 'print.rendered', id: this.id, pages: null, error: 'range' })
          return
        }
        ranges = parsed
        pdf = await this.page.printToPDF(pdfOptions(settings, ranges))
        if (seq !== this.seq) return
      }
      this.pdf = pdf
      this.pdfSettings = JSON.stringify(settings)
      this.ranges = ranges
      await this.show(pdf, seq)
      if (seq === this.seq) this.host.emit({ type: 'print.rendered', id: this.id, pages: countPdfPages(pdf), error: null })
    } catch {
      if (seq !== this.seq) return
      this.pdf = null
      this.pdfSettings = null
      this.host.emit({ type: 'print.rendered', id: this.id, pages: null, error: 'failed' })
    }
  }

  private async show(pdf: Buffer, seq: number): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const file = join(this.dir, `${process.pid}-${this.id}-${seq}.pdf`)
    await writeFile(file, pdf)
    if (seq !== this.seq || this.view.webContents.isDestroyed()) return void rm(file, { force: true })
    this.files.push(file)
    // Whole pages in view, without the viewer's toolbar, as Chrome's preview shows them.
    void this.view.webContents.loadURL(`${pathToFileURL(file).href}#toolbar=0&navpanes=0&view=Fit`).catch(() => {})
  }

  private place(): void {
    if (this.done) return
    if (this.area && this.loaded) {
      this.view.setBounds(this.area)
      if (!this.attached) this.host.attach(this.view)
      this.attached = true
    } else if (this.attached) {
      this.host.detach(this.view)
      this.attached = false
    }
  }
}

/** The panel's choices, kept within what can be printed. */
function clean(settings: PrintSettings, previous: PrintSettings, pageSize: string | null): PrintSettings {
  return {
    ...previous,
    ...settings,
    paper: settings.paper === 'page' && !pageSize ? previous.paper : settings.paper,
    copies: Math.max(1, Math.min(999, Math.round(Number(settings.copies)) || 1)),
    scale: validScale(settings.scale) ? settings.scale : previous.scale,
    range: String(settings.range ?? '')
  }
}
