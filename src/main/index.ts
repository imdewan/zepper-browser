import { Menu, app, dialog } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AdBlock } from './adblock'
import { bangs } from './bangs'
import { History } from './history'
import { SemanticHistory } from './semantic'
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

// A second, isolated instance with its own profile (for automated checks, and trying an update).
if (process.env['ZEPPER_PROFILE']) {
  app.setPath('userData', process.env['ZEPPER_PROFILE'])
  // Test instances usually sit behind other windows; keep animating there.
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  // A packaged test copy keeps out of your Keychain (it's signed differently, so macOS would ask).
  if (app.isPackaged) app.commandLine.appendSwitch('use-mock-keychain')
}

// Sharing the Mac's audio along with a window or screen (Core Audio taps, macOS 14.2 and later).
app.commandLine.appendSwitch('enable-features', 'MacCatapLoopbackAudioForScreenShare')

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

  // Links and files opened from other apps (Zepper as the default browser). They can arrive
  // before the first window exists, so they wait for it.
  const pendingUrls: string[] = []
  const openFromOutside = (url: string): void => {
    if (hub) hub.openUrl(url)
    else pendingUrls.push(url)
  }
  app.on('open-url', (event, url) => {
    event.preventDefault()
    openFromOutside(url)
  })
  app.on('open-file', (event, path) => {
    event.preventDefault()
    openFromOutside(pathToFileURL(path).href)
  })

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
      semantic: new SemanticHistory(history),
      adblock,
      settings: new SettingsStore(),
      rendererUrl: process.env['ELECTRON_RENDERER_URL'],
      rendererDir: join(__dirname, '../renderer')
    })
    // Development: the debugger (--inspect) can reach the app's state.
    if (process.env['ZEPPER_DEBUG_PORT'] && !app.isPackaged) Object.assign(globalThis, { zepperHub: hub })
    await hub.widevineSettled(15_000)
    hub.openWindow('main')
    for (const url of pendingUrls.splice(0)) hub.openUrl(url)
    hub.startExtensions()
    hub.updater.start()
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

  let quitConfirmed = false
  app.on('before-quit', (event) => {
    // Only the main window comes back after a restart: ask before closing other windows' tabs.
    const others = hub && !hub.quitWithoutAsking ? hub.unrestoredWindows() : 0
    if (!quitConfirmed && others > 0) {
      const choice = dialog.showMessageBoxSync({
        type: 'question',
        message: 'Quit Zepper?',
        detail: `${others === 1 ? 'Another window is' : `${others} other windows are`} open. Only the main window’s tabs come back next time.`,
        buttons: ['Quit', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      })
      if (choice !== 0) return event.preventDefault()
      quitConfirmed = true
    }
    if (hub?.services.settings.get().clearHistoryOnQuit) history.clearSince(0)
    hub?.persist()
    history.flush()
  })

  app.on('window-all-closed', () => app.quit())
}
