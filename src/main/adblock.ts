import { ElectronBlocker } from '@ghostery/adblocker-electron'
import { app, ipcMain, type Session } from 'electron'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'tldts-experimental'

const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

export const COSMETICS_CHANNEL = 'zepper:cosmetics'
export const COSMETICS_DOM_CHANNEL = 'zepper:cosmetics-dom'

export interface CosmeticsResponse {
  styles: string
  scripts: string[]
}

/**
 * Built-in ad and tracker blocking, uBlock Origin–style.
 *
 * - Network requests are matched by Ghostery's engine against uBlock Origin's
 *   default lists (EasyList, EasyPrivacy, Peter Lowe, uBO filters/badware/
 *   privacy/quick-fixes/unbreak).
 * - Cosmetic filters and scriptlets are handed to our page preload
 *   synchronously, so they apply at document start, before any page script
 *   runs. That is what defeats YouTube's player ads; the stock Electron
 *   integration injects them asynchronously, after the page has started.
 */
export class AdBlock {
  private blocker: ElectronBlocker | null = null
  private readonly cachePath = join(app.getPath('userData'), 'adblock-engine.bin')
  private enabled = true

  constructor(
    private readonly session: Session,
    private readonly onBlocked: (webContentsId: number) => void
  ) {
    ipcMain.on(COSMETICS_CHANNEL, (event, url: string) => {
      event.returnValue = this.cosmetics(url)
    })
    ipcMain.handle(COSMETICS_DOM_CHANNEL, (_event, payload: { url: string; classes: string[]; ids: string[]; hrefs: string[] }) =>
      this.domCosmetics(payload)
    )
  }

  async start(): Promise<void> {
    if (await this.cacheIsStale()) await unlink(this.cachePath).catch(() => {})
    try {
      this.blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
        path: this.cachePath,
        read: async (path) => new Uint8Array(await readFile(path)),
        write: (path, buffer) => writeFile(path, buffer)
      })
      this.blocker.on('request-blocked', (request) => this.onBlocked(request.tabId))
      this.applyNetworkBlocking()
    } catch (error) {
      console.error('[adblock] failed to load filter lists', error)
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.applyNetworkBlocking()
  }

  private applyNetworkBlocking(): void {
    const blocker = this.blocker
    if (blocker && this.enabled) {
      this.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, blocker.onBeforeRequest)
      this.session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, blocker.onHeadersReceived)
    } else {
      this.session.webRequest.onBeforeRequest(null)
      this.session.webRequest.onHeadersReceived(null)
    }
  }

  /** Hostname-specific hiding rules, generic base rules and scriptlets for a page. */
  private cosmetics(url: string): CosmeticsResponse {
    const empty = { styles: '', scripts: [] }
    if (!this.blocker || !this.enabled || !/^https?:/.test(url)) return empty
    const { hostname, domain } = parse(url)
    if (!hostname) return empty
    const result = this.blocker.getCosmeticsFilters({
      url,
      hostname,
      domain,
      getBaseRules: true,
      getInjectionRules: true,
      getExtendedRules: false,
      getRulesFromHostname: true,
      getRulesFromDOM: false
    })
    return { styles: result.styles, scripts: result.scripts }
  }

  /** Generic class/id/href hiding rules for what the page actually contains. */
  private domCosmetics(payload: { url: string; classes: string[]; ids: string[]; hrefs: string[] }): CosmeticsResponse {
    const empty = { styles: '', scripts: [] }
    if (!this.blocker || !this.enabled) return empty
    const { hostname, domain } = parse(payload.url)
    if (!hostname) return empty
    const result = this.blocker.getCosmeticsFilters({
      url: payload.url,
      hostname,
      domain,
      classes: payload.classes,
      ids: payload.ids,
      hrefs: payload.hrefs,
      getBaseRules: false,
      getInjectionRules: false,
      getExtendedRules: false,
      getRulesFromHostname: false,
      getRulesFromDOM: true
    })
    return { styles: result.styles, scripts: [] }
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
