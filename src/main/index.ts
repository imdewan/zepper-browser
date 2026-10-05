import { Menu, app, session } from 'electron'
import { join } from 'node:path'
import { AdBlock } from './adblock'
import { Browser } from './browser'
import { History } from './history'
import { buildMenu } from './menu'
import { SettingsStore } from './settings-store'

app.setName('Zepper')

// Present a plain Chrome user agent: many sites (Google sign-in, WhatsApp Web,
// Teams) refuse or degrade when they see Electron or an unknown app token.
app.userAgentFallback = app.userAgentFallback
  .replace(/\(KHTML, like Gecko\) .*?Chrome\//, '(KHTML, like Gecko) Chrome/')
  .replace(/ Electron\/\S+/, '')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let browser: Browser | null = null
  const history = new History()

  void app.whenReady().then(async () => {
    const icon = join(__dirname, '../../resources/icon.png')
    app.setAboutPanelOptions({
      applicationName: 'Zepper',
      applicationVersion: app.getVersion(),
      copyright: '© 2026 Dewan Shakil',
      iconPath: icon
    })
    const adblock = new AdBlock(session.defaultSession, (id) => browser?.onAdBlocked(id))
    browser = new Browser(history, adblock, new SettingsStore())
    Menu.setApplicationMenu(buildMenu(browser))
    browser.start(process.env['ELECTRON_RENDERER_URL'], join(__dirname, '../renderer'))
    await adblock.start()
  })

  app.on('second-instance', () => {
    const win = browser?.window()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.on('before-quit', () => {
    browser?.persistNow()
    history.flush()
  })

  app.on('window-all-closed', () => app.quit())
}
