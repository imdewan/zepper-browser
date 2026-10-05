import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * A JSON file in the profile that is written atomically (tmp file + rename)
 * and debounced, so frequent state changes cost at most one write per delay.
 */
export class JsonFile<T> {
  private readonly path: string
  private timer: NodeJS.Timeout | null = null
  private pending: T | null = null

  constructor(
    name: string,
    private readonly delayMs = 1000
  ) {
    this.path = join(app.getPath('userData'), name)
  }

  read(): T | null {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as T
    } catch {
      return null
    }
  }

  schedule(value: T): void {
    this.pending = value
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.delayMs)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.pending === null) return
    const value = this.pending
    this.pending = null
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(value))
    renameSync(tmp, this.path)
  }
}
