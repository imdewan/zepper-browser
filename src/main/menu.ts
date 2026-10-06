import { Menu, app, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { Browser } from './browser'
import type { Hub } from './hub'

/**
 * The application menu doubles as the keyboard shortcut table: menu
 * accelerators fire even when a web page has focus.
 */
export function buildMenu(hub: Hub): Menu {
  /**
   * Shortcuts act on whichever window is focused. With a sign-in popup in front, page
   * shortcuts (close, reload, zoom…) act on the popup instead, never on the window behind it.
   */
  const run = (fn: (browser: Browser) => void, onPopup?: (popup: BrowserWindow) => void) => (): void => {
    const popup = hub.focusedForeignWindow()
    if (popup) return onPopup?.(popup)
    const browser = hub.focused()
    if (browser) fn(browser)
  }
  const isDev = !app.isPackaged

  const tabItems: MenuItemConstructorOptions[] = Array.from({ length: 8 }, (_, i) => ({
    label: `Select Tab ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    visible: false,
    click: run((browser) => browser.selectTabIndex(i + 1))
  }))
  const essentialItems: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: `Essential ${i + 1}`,
    accelerator: `Alt+${i + 1}`,
    visible: false,
    click: run((browser) => browser.selectEssential(i + 1))
  }))
  const spaceItems: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: `Switch to Space ${i + 1}`,
    accelerator: `Control+${i + 1}`,
    visible: false,
    click: run((browser) => browser.switchSpaceIndex(i + 1))
  }))

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, click: run((browser) => browser.handle({ type: 'ui.openAbout' })) },
        { label: 'Check for Updates…', click: run((browser) => browser.handle({ type: 'app.checkForUpdates' })) },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: run((browser) => browser.handle({ type: 'ui.openSettings' })) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: run((browser) => browser.handle({ type: 'ui.openPalette', mode: 'new' })) },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => void hub.openWindow('blank') },
        { label: 'New Private Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => void hub.openWindow('private') },
        {
          label: 'Open Location…',
          accelerator: 'CmdOrCtrl+L',
          click: run((browser) => browser.handle({ type: 'ui.openPalette', mode: 'current' }))
        },
        {
          label: 'Open File…',
          accelerator: 'CmdOrCtrl+O',
          click: run((browser) => void browser.openFileDialog())
        },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: run(
            (browser) => browser.closeActive(),
            (popup) => popup.close()
          )
        },
        {
          label: 'Close Window',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: run(
            (browser) => browser.window().close(),
            (popup) => popup.close()
          )
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: run((browser) => browser.handle({ type: 'tab.reopenClosed' }))
        },
        { type: 'separator' },
        { label: 'Save Page As…', accelerator: 'CmdOrCtrl+Shift+S', click: run((browser) => void browser.savePageAs()) },
        { label: 'Export as PDF…', click: run((browser) => void browser.exportPdf()) },
        {
          label: 'Print…',
          accelerator: 'CmdOrCtrl+P',
          click: run(
            (browser) => browser.printActive(),
            (popup) => popup.webContents.print({}, () => {})
          )
        },
        { type: 'separator' },
        { label: 'Capture…', accelerator: 'CmdOrCtrl+Shift+2', click: run((browser) => void browser.startCapture()) },
        { type: 'separator' },
        { label: 'Copy Current URL', accelerator: 'CmdOrCtrl+Shift+C', click: run((browser) => browser.handle({ type: 'ui.copyUrl' })) },
        {
          label: 'Copy URL as Markdown',
          accelerator: 'CmdOrCtrl+Alt+Shift+C',
          click: run((browser) => browser.handle({ type: 'ui.copyUrl', markdown: true }))
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: run((browser) => browser.openFind()) },
        { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: run((browser) => browser.findAgain(true)) },
        { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: run((browser) => browser.findAgain(false)) }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload Page',
          accelerator: 'CmdOrCtrl+R',
          click: run(
            (browser) => browser.reloadActive(false),
            (popup) => popup.webContents.reload()
          )
        },
        {
          label: 'Reload Ignoring Cache',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: run(
            (browser) => browser.reloadActive(true),
            (popup) => popup.webContents.reloadIgnoringCache()
          )
        },
        { type: 'separator' },
        { label: 'Toggle Compact Mode', accelerator: 'CmdOrCtrl+S', click: run((browser) => browser.handle({ type: 'ui.toggleCompact' })) },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: run((browser) => browser.zoomActive(1)) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', visible: false, click: run((browser) => browser.zoomActive(1)) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: run((browser) => browser.zoomActive(-1)) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: run((browser) => browser.zoomActive(0)) },
        { type: 'separator' },
        { label: 'View Page Source', accelerator: 'CmdOrCtrl+Alt+U', click: run((browser) => browser.viewSource()) },
        { label: 'Summarise or Ask This Page', accelerator: 'CmdOrCtrl+Shift+A', click: run((browser) => browser.openAssistant()) },
        {
          label: 'Developer Tools',
          accelerator: 'CmdOrCtrl+Alt+I',
          click: run(
            (browser) => browser.toggleDevTools(),
            (popup) => popup.webContents.toggleDevTools()
          )
        },
        ...(isDev
          ? [
              {
                label: 'Browser UI DevTools',
                accelerator: 'CmdOrCtrl+Alt+Shift+I',
                click: run((browser) => browser.toggleChromeDevTools())
              }
            ]
          : []),
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: run((browser) => browser.handle({ type: 'nav.back' })) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: run((browser) => browser.handle({ type: 'nav.forward' })) },
        { type: 'separator' },
        { label: 'Show All History', accelerator: 'CmdOrCtrl+Y', click: run((browser) => browser.handle({ type: 'ui.openHistory' })) },
        { label: 'Downloads', accelerator: 'Alt+CmdOrCtrl+L', click: run((browser) => browser.handle({ type: 'ui.downloads' })) }
      ]
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Switch to Recent Tab', accelerator: 'Control+Tab', click: run((browser) => browser.cycleRecent(1)) },
        { label: 'Switch to Recent Tab (Back)', accelerator: 'Control+Shift+Tab', click: run((browser) => browser.cycleRecent(-1)) },
        { label: 'Next Tab', accelerator: 'CmdOrCtrl+Alt+Down', click: run((browser) => browser.cycleTab(1)) },
        { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Alt+Up', click: run((browser) => browser.cycleTab(-1)) },
        { type: 'separator' },
        { label: 'Pin / Unpin Tab', accelerator: 'CmdOrCtrl+D', click: run((browser) => browser.togglePinActive()) },
        { label: 'Pin / Unpin Tab', accelerator: 'CmdOrCtrl+Shift+D', visible: false, click: run((browser) => browser.togglePinActive()) },
        { label: 'Clear Unpinned Tabs', accelerator: 'CmdOrCtrl+Shift+K', click: run((browser) => browser.clearActiveSpace()) },
        { type: 'separator' },
        ...tabItems,
        { label: 'Select Last Tab', accelerator: 'CmdOrCtrl+9', visible: false, click: run((browser) => browser.selectTabIndex(9)) },
        ...essentialItems
      ]
    },
    {
      label: 'Split View',
      submenu: [
        { label: 'Add Split Pane', accelerator: 'Control+Shift+=', click: run((browser) => browser.addSplitPane()) },
        { label: 'Remove Split Pane', accelerator: 'Control+Shift+-', click: run((browser) => browser.removeSplitPane()) },
        { type: 'separator' },
        { label: 'Side by Side', accelerator: 'CmdOrCtrl+Alt+V', click: run((browser) => browser.splitWithLayout('horizontal')) },
        { label: 'Stacked', accelerator: 'CmdOrCtrl+Alt+H', click: run((browser) => browser.splitWithLayout('vertical')) },
        { label: 'Grid', accelerator: 'CmdOrCtrl+Alt+G', click: run((browser) => browser.splitWithLayout('grid')) },
        { type: 'separator' },
        { label: 'Unsplit All', accelerator: 'CmdOrCtrl+Alt+U', click: run((browser) => browser.dissolveActiveSplit()) }
      ]
    },
    {
      label: 'Spaces',
      submenu: [
        { label: 'Next Space', accelerator: 'CmdOrCtrl+Alt+Right', click: run((browser) => browser.switchSpaceRelative(1)) },
        { label: 'Previous Space', accelerator: 'CmdOrCtrl+Alt+Left', click: run((browser) => browser.switchSpaceRelative(-1)) },
        ...spaceItems
      ]
    },
    { role: 'windowMenu' }
  ]
  return Menu.buildFromTemplate(template)
}
