import { session, type BrowserWindow, type Extension, type Session, type WebContents } from 'electron'
import { ElectronChromeExtensions, setSessionPartitionResolver } from 'electron-chrome-extensions'
import { installChromeWebStore, uninstallExtension } from 'electron-chrome-web-store'
import type { ExtensionInfo } from '@shared/types'
import type { SettingsStore } from './settings-store'

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

  /** Enables Web Store installs and loads previously installed extensions (except ones you turned off). */
  async start(settings: SettingsStore): Promise<void> {
    this.settings = settings
    try {
      await installChromeWebStore({ session: session.defaultSession })
    } catch (error) {
      console.error('[extensions] failed to start the Chrome Web Store integration', error)
    }
    for (const off of settings.get().disabledExtensions) {
      if (session.defaultSession.extensions.getExtension(off.id)) session.defaultSession.extensions.removeExtension(off.id)
    }
  }

  private settings: SettingsStore | null = null

  /** Installed extensions, loaded or turned off, for Settings. */
  list(): ExtensionInfo[] {
    const loaded = session.defaultSession.extensions.getAllExtensions().map((e) => describe(e, true))
    const off = (this.settings?.get().disabledExtensions ?? []).map(({ path: _path, ...rest }) => ({ ...rest, enabled: false }))
    return [...loaded, ...off.filter((o) => !loaded.some((l) => l.id === o.id))].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Turning an extension off unloads it now and on every launch; turning it on loads it again. */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const settings = this.settings
    if (!settings) return
    const disabled = settings.get().disabledExtensions
    if (enabled) {
      const entry = disabled.find((d) => d.id === id)
      if (!entry) return
      settings.update({ disabledExtensions: disabled.filter((d) => d.id !== id) })
      await session.defaultSession.extensions.loadExtension(entry.path, { allowFileAccess: true }).catch((error) => {
        console.error('[extensions] failed to load', id, error)
      })
      return
    }
    const extension = session.defaultSession.extensions.getExtension(id)
    if (!extension) return
    const { enabled: _enabled, ...info } = describe(extension, true)
    settings.update({ disabledExtensions: [...disabled.filter((d) => d.id !== id), { ...info, path: extension.path }] })
    session.defaultSession.extensions.removeExtension(id)
  }

  /** Uninstalls an extension (its files too). */
  async remove(id: string): Promise<void> {
    const settings = this.settings
    if (settings) {
      const { disabledExtensions, pinnedExtensions } = settings.get()
      settings.update({
        disabledExtensions: disabledExtensions.filter((d) => d.id !== id),
        pinnedExtensions: pinnedExtensions.filter((p) => p !== id)
      })
    }
    await uninstallExtension(id, { session: session.defaultSession }).catch((error) => {
      console.error('[extensions] failed to uninstall', id, error)
    })
  }

  /** The extension's own settings page, if it has one. */
  optionsUrl(id: string): string | null {
    const extension = session.defaultSession.extensions.getExtension(id)
    const manifest = extension?.manifest as { options_ui?: { page?: string }; options_page?: string } | undefined
    const page = manifest?.options_ui?.page ?? manifest?.options_page
    return extension && page ? `chrome-extension://${id}/${page.replace(/^\//, '')}` : null
  }
}

function describe(extension: Extension, enabled: boolean): ExtensionInfo {
  const manifest = extension.manifest as { description?: string; options_ui?: { page?: string }; options_page?: string; name?: string }
  return {
    id: extension.id,
    name: extension.name,
    version: extension.version,
    description: localized(manifest.description ?? '', extension),
    enabled,
    hasOptions: !!(manifest.options_ui?.page ?? manifest.options_page)
  }
}

/** Manifest strings like "__MSG_appDesc__" are localized; without the messages, leave them out. */
function localized(text: string, _extension: Extension): string {
  return /^__MSG_.+__$/.test(text) ? '' : text
}
