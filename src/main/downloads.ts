import { dialog, shell, type DownloadItem } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { DownloadEntry } from '@shared/types'
import { fileTypeIcon } from './native'
import { JsonFile } from './persist'
import { DEFAULT_PROFILE } from './profiles'

/** Files that run code when opened. */
const RUNNABLE = /\.(app|command|tool|terminal|sh|zsh|bash|pkg|mpkg|dmg|scpt|applescript|workflow|jar|py|rb|pl)$/i

const MAX_ENTRIES = 100
/** Progress updates arrive many times a second; windows hear about them a few times a second. */
const NOTIFY_MS = 250

/**
 * Every download, in all windows: live progress while it runs, and a list that survives restarts
 * (except private windows' downloads, which are never written to disk). Each belongs to the profile
 * it was downloaded in, and a window lists the current space's.
 */
export class Downloads {
  /** File-type icons (data URLs), by extension. */
  private readonly icons = new Map<string, string | null>()
  private readonly file = new JsonFile<DownloadEntry[]>('downloads.json', 1000)
  private entries: DownloadEntry[]
  private readonly active = new Map<string, DownloadItem>()
  private notifyTimer: NodeJS.Timeout | null = null

  constructor(private readonly onChange: () => void) {
    // Anything still running when Zepper quit didn't finish.
    this.entries = (this.file.read() ?? []).map((e) =>
      e.state === 'progressing' || e.state === 'paused' ? { ...e, state: 'interrupted' } : e
    )
  }

  /** A download's icon as Finder shows it for its kind of file (a data URL), cached by kind. */
  iconOf(id: string): string | null {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return null
    const kind = extname(entry.filename).slice(1).toLowerCase()
    if (!this.icons.has(kind)) this.icons.set(kind, fileTypeIcon(kind, 72))
    return this.icons.get(kind) ?? null
  }

  /** Where a finished download is on disk (null if it isn't there any more). */
  pathOf(id: string): string | null {
    const entry = this.entries.find((e) => e.id === id)
    return entry && entry.state === 'completed' && existsSync(entry.path) ? entry.path : null
  }

  /** What a window shows: the profile's downloads (private windows see their own too). */
  list(includePrivate: boolean, profile: string): DownloadEntry[] {
    return this.entries.filter((e) => (e.private ? includePrivate : (e.profile ?? DEFAULT_PROFILE) === profile))
  }

  track(item: DownloadItem, path: string, isPrivate: boolean, profile: string, site?: string): void {
    const entry: DownloadEntry = {
      id: randomUUID(),
      filename: basename(path),
      url: item.getURL(),
      ...(site ? { site } : {}),
      path,
      state: 'progressing',
      received: 0,
      total: item.getTotalBytes(),
      startedAt: Date.now(),
      private: isPrivate,
      ...(profile !== DEFAULT_PROFILE ? { profile } : {})
    }
    this.entries = [entry, ...this.entries].slice(0, MAX_ENTRIES)
    this.active.set(entry.id, item)
    item.on('updated', (_event, state) => {
      const saved = item.getSavePath()
      if (saved && saved !== entry.path) {
        entry.path = saved
        entry.filename = basename(saved)
      }
      entry.received = item.getReceivedBytes()
      entry.total = item.getTotalBytes()
      entry.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing'
      this.changed()
    })
    item.once('done', (_event, state) => {
      if (item.getSavePath()) {
        entry.path = item.getSavePath()
        entry.filename = basename(entry.path)
      }
      entry.received = item.getReceivedBytes()
      entry.state = state
      this.active.delete(entry.id)
      this.changed(true)
    })
    this.changed(true)
  }

  open(id: string): void {
    const entry = this.entry(id)
    if (!entry || !existsSync(entry.path)) return
    // Programs and installers can change your Mac: check before running one from the web.
    if (RUNNABLE.test(entry.path)) {
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        message: `Open “${basename(entry.path)}”?`,
        detail: 'This file is a program or installer from the web. Open it only if you trust where it came from.',
        buttons: ['Open', 'Cancel'],
        defaultId: 1,
        cancelId: 1
      })
      if (choice !== 0) return
    }
    void shell.openPath(entry.path)
  }

  reveal(id: string): void {
    const entry = this.entry(id)
    if (entry && existsSync(entry.path)) shell.showItemInFolder(entry.path)
  }

  pause(id: string): void {
    this.active.get(id)?.pause()
  }

  resume(id: string): void {
    const item = this.active.get(id)
    if (item?.canResume()) item.resume()
  }

  cancel(id: string): void {
    this.active.get(id)?.cancel()
  }

  /** Removes an entry from the list (cancelling it if it's still running); the file stays. */
  remove(id: string): void {
    this.cancel(id)
    this.entries = this.entries.filter((e) => e.id !== id)
    this.changed(true)
  }

  /** Moves the downloaded file to the Trash (you can put it back from there) and drops it from the list. */
  async trash(id: string): Promise<void> {
    const entry = this.entry(id)
    if (!entry || this.active.has(id)) return
    if (existsSync(entry.path)) await shell.trashItem(entry.path).catch((error) => console.warn('[downloads] could not trash', error))
    this.entries = this.entries.filter((e) => e.id !== id)
    this.changed(true)
  }

  /** Clears finished entries (a profile's, or everyone's); running downloads stay. */
  clear(profile?: string): void {
    this.entries = this.entries.filter(
      (e) => this.active.has(e.id) || (profile !== undefined && (e.profile ?? DEFAULT_PROFILE) !== profile)
    )
    this.changed(true)
  }

  /** Forgets a profile's downloads (nothing uses it any more); the files stay. */
  forget(profile: string): void {
    this.entries = this.entries.filter((e) => this.active.has(e.id) || (e.profile ?? DEFAULT_PROFILE) !== profile)
    this.changed(true)
  }

  private entry(id: string): DownloadEntry | undefined {
    return this.entries.find((e) => e.id === id)
  }

  private changed(now = false): void {
    if (now) {
      this.file.schedule(this.entries.filter((e) => !e.private))
      if (this.notifyTimer) clearTimeout(this.notifyTimer)
      this.notifyTimer = null
      this.onChange()
      return
    }
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.onChange()
    }, NOTIFY_MS)
  }

  flush(): void {
    this.file.schedule(this.entries.filter((e) => !e.private))
    this.file.flush()
  }
}
