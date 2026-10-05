import { session, type BrowserWindow, type Session, type WebContents } from 'electron'
import { ElectronChromeExtensions, setSessionPartitionResolver } from 'electron-chrome-extensions'
import { installChromeWebStore } from 'electron-chrome-web-store'

/** Partition name the browser UI uses to reach the browsing session's extensions. */
export const BROWSING_PARTITION = 'zepper-browsing'

export interface ExtensionHost {
  window(): BrowserWindow
  createTab(url: string, active: boolean): WebContents
  selectTab(webContents: WebContents): void
  removeTab(webContents: WebContents): void
}

/**
 * Chrome extension support: installing from the Chrome Web Store (and
 * auto-updating), plus the chrome.tabs / windows / action / contextMenus APIs
 * that Electron doesn't provide on its own.
 */
export class Extensions {
  readonly api: ElectronChromeExtensions

  constructor(host: ExtensionHost, uiSession: Session) {
    setSessionPartitionResolver((partition) =>
      partition === BROWSING_PARTITION ? session.defaultSession : session.fromPartition(partition)
    )
    this.api = new ElectronChromeExtensions({
      license: 'GPL-3.0',
      session: session.defaultSession,
      createTab: async (details) => [host.createTab(details.url ?? 'about:blank', details.active !== false), host.window()],
      selectTab: (webContents) => host.selectTab(webContents),
      removeTab: (webContents) => host.removeTab(webContents),
      createWindow: async (details) => {
        const urls = details.url ? ([] as string[]).concat(details.url) : []
        for (const url of urls) host.createTab(url, true)
        return host.window()
      },
      removeWindow: () => {}
    })
    // Extension icons in the browser UI are served over crx:// from the UI's own session.
    ElectronChromeExtensions.handleCRXProtocol(uiSession)
  }

  /** Enables Web Store installs and loads previously installed extensions. */
  async start(): Promise<void> {
    try {
      await installChromeWebStore({ session: session.defaultSession })
    } catch (error) {
      console.error('[extensions] failed to start the Chrome Web Store integration', error)
    }
  }
}
