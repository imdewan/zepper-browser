import { shell, type DownloadItem } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { DownloadEntry } from '@shared/types'
import { JsonFile } from './persist'

const MAX_ENTRIES = 100
/** Progress updates arrive many times a second; windows hear about them a few times a second. */
const NOTIFY_MS = 250

/**
 * Every download, shared by all windows: live progress while it runs, and a
 * list that survives restarts (except private windows' downloads, which are
 * never written to disk).
 */
export class Downloads {
  private readonly file = new JsonFile<DownloadEntry[]>('downloads.json', 1000)
  private entries: DownloadEntry[]
  private readonly active = new Map<string, DownloadItem>()
  private notifyTimer: NodeJS.Timeout | null = null

  constructor(private readonly onChange: () => void) {
    // Anything still running when Zepper quit didn't finish.
    this.entries = (this.file.read() ?? []).map((e) => (e.state === 'progressing' || e.state === 'paused' ? { ...e, state: 'interrupted' } : e))
  }

  /** What a window shows: private windows see their own downloads too. */
  list(includePrivate: boolean): DownloadEntry[] {
    return includePrivate ? this.entries : this.entries.filter((e) => !e.private)
  }

  track(item: DownloadItem, path: string, isPrivate: boolean): void {
    const entry: DownloadEntry = {
      id: randomUUID(),
      filename: basename(path),
      url: item.getURL(),
      path,
      state: 'progressing',
      received: 0,
      total: item.getTotalBytes(),
      startedAt: Date.now(),
      private: isPrivate
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
    if (entry && existsSync(entry.path)) void shell.openPath(entry.path)
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

  /** Clears finished entries; running downloads stay. */
  clear(): void {
    this.entries = this.entries.filter((e) => this.active.has(e.id))
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
