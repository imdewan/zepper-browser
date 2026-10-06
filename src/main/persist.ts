import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * A JSON file in the profile, written atomically (tmp file + rename) and debounced, so frequent
 * state changes cost at most one write per delay. Unchanged content isn't written again, routine
 * writes happen off the main thread, and flush() (on quit) writes synchronously.
 */
export class JsonFile<T> {
  private readonly path: string
  private timer: NodeJS.Timeout | null = null
  private pending: T | null = null
  /** What's on disk (or on its way there). */
  private written: string | null = null
  /** Each write's turn; a background write that's been overtaken by a newer one doesn't land. */
  private version = 0
  private writing: Promise<void> = Promise.resolve()

  constructor(
    name: string,
    private readonly delayMs = 1000
  ) {
    this.path = join(app.getPath('userData'), name)
  }

  read(): T | null {
    try {
      const text = readFileSync(this.path, 'utf8')
      this.written = text
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }

  schedule(value: T): void {
    this.pending = value
    if (this.timer) return
    this.timer = setTimeout(() => this.writeLater(), this.delayMs)
  }

  /** Writes now, synchronously (when quitting). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const text = this.take()
    if (text === null) return
    const version = ++this.version
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${version}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, this.path)
  }

  /** The pending content as text, if it differs from what was last written. */
  private take(): string | null {
    if (this.pending === null) return null
    const text = JSON.stringify(this.pending)
    this.pending = null
    if (text === this.written) return null
    this.written = text
    return text
  }

  private writeLater(): void {
    this.timer = null
    const text = this.take()
    if (text === null) return
    const version = ++this.version
    this.writing = this.writing
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true })
        const tmp = `${this.path}.${version}.tmp`
        await writeFile(tmp, text)
        // A newer write (a sync flush, say) has landed meanwhile: leave it.
        if (version !== this.version) return void (await unlink(tmp).catch(() => {}))
        await rename(tmp, this.path)
      })
      .catch((error) => console.warn('[persist] could not save', this.path, error))
  }
}
