import { Menu, app } from 'electron'
import { join } from 'node:path'
import { AdBlock } from './adblock'
import { bangs } from './bangs'
import { History } from './history'
import { Hub } from './hub'
import { buildMenu } from './menu'
import { SettingsStore } from './settings-store'

app.setName('Zepper')

// With Widevine off we disable castLabs' component updater, and its own background
// install then rejects internally ("No component available"). That's expected.
// Logged rather than shown as Electron's "A JavaScript error occurred" dialog; Zepper keeps running.
process.on('uncaughtException', (error) => {
  console.error('[zepper] Uncaught error in the main process:', error)
})

process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error && reason.message === 'No component available') return
  console.error('Unhandled promise rejection:', reason)
})

// Development only: a second, isolated instance with its own profile (for automated checks).
if (!app.isPackaged && process.env['ZEPPER_PROFILE']) {
  app.setPath('userData', process.env['ZEPPER_PROFILE'])
  // Test instances usually sit behind other windows; keep animating there.
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
}

// Present a plain Chrome user agent: many sites (Google sign-in, WhatsApp Web,
// Teams) refuse or degrade when they see Electron or an unknown app token.
app.userAgentFallback = app.userAgentFallback
  .replace(/\(KHTML, like Gecko\) .*?Chrome\//, '(KHTML, like Gecko) Chrome/')
  .replace(/ Electron\/\S+/, '')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let hub: Hub | null = null
  const history = new History()

  void app.whenReady().then(async () => {
    const icon = join(__dirname, '../../resources/icon.png')
    app.setAboutPanelOptions({
      applicationName: 'Zepper',
      applicationVersion: app.getVersion(),
      copyright: '© 2026 Dewan Shakil',
      iconPath: icon
    })
    const adblock = new AdBlock((id) => hub?.ownerOfWebContentsId(id)?.onAdBlocked(id))
    hub = new Hub({
      history,
      adblock,
      settings: new SettingsStore(),
      rendererUrl: process.env['ELECTRON_RENDERER_URL'],
      rendererDir: join(__dirname, '../renderer')
    })
    await hub.widevineSettled(15_000)
    hub.openWindow('main')
    hub.startExtensions()
    Menu.setApplicationMenu(buildMenu(hub))
    await adblock.start()
    void bangs.load()
  })

  app.on('second-instance', () => {
    const win = hub?.focusedNormal().window()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.on('before-quit', () => {
    if (hub?.services.settings.get().clearHistoryOnQuit) history.clearSince(0)
    hub?.persist()
    history.flush()
  })

  app.on('window-all-closed', () => app.quit())
}
