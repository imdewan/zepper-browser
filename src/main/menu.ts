import { Menu, app, type MenuItemConstructorOptions } from 'electron'
import type { Browser } from './browser'

/**
 * The application menu doubles as the keyboard shortcut table: menu
 * accelerators fire even when a web page has focus.
 */
export function buildMenu(browser: Browser): Menu {
  const run = (fn: () => void) => () => fn()
  const isDev = !app.isPackaged

  const tabItems: MenuItemConstructorOptions[] = Array.from({ length: 8 }, (_, i) => ({
    label: `Select Tab ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    visible: false,
    click: run(() => browser.selectTabIndex(i + 1))
  }))
  const spaceItems: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: `Switch to Space ${i + 1}`,
    accelerator: `Control+${i + 1}`,
    visible: false,
    click: run(() => browser.switchSpaceIndex(i + 1))
  }))

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: run(() => browser.handle({ type: 'ui.openSettings' })) },
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
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: run(() => browser.handle({ type: 'ui.openPalette', mode: 'new' })) },
        { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: run(() => browser.handle({ type: 'ui.openPalette', mode: 'current' })) },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: run(() => browser.closeActive()) },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: run(() => browser.handle({ type: 'tab.reopenClosed' })) },
        { type: 'separator' },
        { label: 'Copy Current URL', accelerator: 'CmdOrCtrl+Shift+C', click: run(() => browser.handle({ type: 'ui.copyUrl' })) },
        { label: 'Copy URL as Markdown', accelerator: 'CmdOrCtrl+Alt+Shift+C', click: run(() => browser.handle({ type: 'ui.copyUrl', markdown: true })) }
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
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: run(() => browser.openFind()) },
        { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: run(() => browser.findAgain(true)) },
        { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: run(() => browser.findAgain(false)) }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload Page', accelerator: 'CmdOrCtrl+R', click: run(() => browser.reloadActive(false)) },
        { label: 'Reload Ignoring Cache', accelerator: 'CmdOrCtrl+Shift+R', click: run(() => browser.reloadActive(true)) },
        { type: 'separator' },
        { label: 'Toggle Compact Mode', accelerator: 'CmdOrCtrl+S', click: run(() => browser.handle({ type: 'ui.toggleCompact' })) },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: run(() => browser.zoomActive(1)) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', visible: false, click: run(() => browser.zoomActive(1)) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: run(() => browser.zoomActive(-1)) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: run(() => browser.zoomActive(0)) },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: 'CmdOrCtrl+Alt+I', click: run(() => browser.toggleDevTools()) },
        ...(isDev
          ? [{ label: 'Browser UI DevTools', accelerator: 'CmdOrCtrl+Alt+Shift+I', click: run(() => browser.toggleChromeDevTools()) }]
          : []),
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: run(() => browser.handle({ type: 'nav.back' })) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: run(() => browser.handle({ type: 'nav.forward' })) }
      ]
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Next Tab', accelerator: 'Control+Tab', click: run(() => browser.cycleTab(1)) },
        { label: 'Previous Tab', accelerator: 'Control+Shift+Tab', click: run(() => browser.cycleTab(-1)) },
        { type: 'separator' },
        { label: 'Pin / Unpin Tab', accelerator: 'CmdOrCtrl+Shift+D', click: run(() => browser.togglePinActive()) },
        { label: 'Clear Unpinned Tabs', accelerator: 'CmdOrCtrl+Shift+K', click: run(() => browser.clearActiveSpace()) },
        { type: 'separator' },
        ...tabItems,
        { label: 'Select Last Tab', accelerator: 'CmdOrCtrl+9', visible: false, click: run(() => browser.selectTabIndex(9)) }
      ]
    },
    {
      label: 'Spaces',
      submenu: [
        { label: 'Next Space', accelerator: 'CmdOrCtrl+Alt+Right', click: run(() => browser.switchSpaceRelative(1)) },
        { label: 'Previous Space', accelerator: 'CmdOrCtrl+Alt+Left', click: run(() => browser.switchSpaceRelative(-1)) },
        ...spaceItems
      ]
    },
    { role: 'windowMenu' }
  ]
  return Menu.buildFromTemplate(template)
}
