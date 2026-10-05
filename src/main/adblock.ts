import { ElectronBlocker } from '@ghostery/adblocker-electron'
import { app, type Session } from 'electron'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * Built-in ad and tracker blocking. Uses Ghostery's engine with the same
 * filter lists uBlock Origin ships by default (EasyList, EasyPrivacy, Peter
 * Lowe, and uBO's filters/badware/privacy/quick-fixes/unbreak lists),
 * including cosmetic filtering and scriptlets.
 */
export class AdBlock {
  private blocker: ElectronBlocker | null = null
  private readonly cachePath = join(app.getPath('userData'), 'adblock-engine.bin')
  private enabled = true

  constructor(
    private readonly session: Session,
    private readonly onBlocked: (webContentsId: number) => void
  ) {}

  async start(): Promise<void> {
    const stale = await this.cacheIsStale()
    if (stale) await unlink(this.cachePath).catch(() => {})
    try {
      this.attach(await this.load())
    } catch (error) {
      console.error('[adblock] failed to load filter lists', error)
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!this.blocker) return
    if (enabled && !this.blocker.isBlockingEnabled(this.session)) {
      this.blocker.enableBlockingInSession(this.session)
    } else if (!enabled && this.blocker.isBlockingEnabled(this.session)) {
      this.blocker.disableBlockingInSession(this.session)
    }
  }

  private load(): Promise<ElectronBlocker> {
    return ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: this.cachePath,
      read: async (path) => new Uint8Array(await readFile(path)),
      write: (path, buffer) => writeFile(path, buffer)
    })
  }

  private attach(blocker: ElectronBlocker): void {
    this.blocker = blocker
    blocker.on('request-blocked', (request) => this.onBlocked(request.tabId))
    if (this.enabled) blocker.enableBlockingInSession(this.session)
  }

  private async cacheIsStale(): Promise<boolean> {
    try {
      const info = await stat(this.cachePath)
      return Date.now() - info.mtimeMs > REFRESH_AFTER_MS
    } catch {
      return false
    }
  }
}
