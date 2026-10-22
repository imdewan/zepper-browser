import { Menu, app, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { SHORTCUT_COMMANDS, acceleratorFor, chordOf, linuxAccelerator } from '@shared/shortcuts'
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
  const linux = process.platform === 'linux'
  /** Your shortcuts (Settings › Shortcuts) over the commands' own. */
  const custom = hub.services.settings.get().shortcuts
  /** A command's shortcut, yours or its own, by its id (see SHORTCUT_COMMANDS). */
  const sc = (id: string): string | undefined => acceleratorFor(id, custom, process.platform) ?? undefined
  /**
   * A second shortcut for a command, while it has its own (yours replaces both), and no other
   * command has been given those keys.
   */
  const alias = (id: string, item: MenuItemConstructorOptions): MenuItemConstructorOptions[] => {
    if (id in custom || typeof item.accelerator !== 'string') return []
    const chord = chordOf(item.accelerator, process.platform)
    const taken = SHORTCUT_COMMANDS.some((c) => {
      const keys = c.id === id ? null : acceleratorFor(c.id, custom, process.platform)
      return keys !== null && chordOf(keys, process.platform) === chord
    })
    return taken ? [] : [item]
  }
  /** The accelerator, or on Linux the one that doesn't clash there (see LINUX_SHORTCUTS), by its Mac label. */
  const keys = (mac: string, accelerator: string): string => (linux && linuxAccelerator(mac)) || accelerator
  /** On Linux, also the keys Linux browsers use (F5, Alt+←…), not shown in the menu. (F11 is Full Screen's own there.) */
  const linuxExtras: MenuItemConstructorOptions[] = linux
    ? [
        { label: 'Reload', accelerator: 'F5', visible: false, click: run((browser) => browser.handle({ type: 'nav.reload' })) },
        { label: 'Reload Ignoring Cache', accelerator: 'Ctrl+F5', visible: false, click: run((browser) => browser.reloadActive(true)) },
        { label: 'Reload Ignoring Cache', accelerator: 'Shift+F5', visible: false, click: run((browser) => browser.reloadActive(true)) },
        { label: 'Back', accelerator: 'Alt+Left', visible: false, click: run((browser) => browser.handle({ type: 'nav.back' })) },
        { label: 'Forward', accelerator: 'Alt+Right', visible: false, click: run((browser) => browser.handle({ type: 'nav.forward' })) },
        { label: 'Developer Tools', accelerator: 'F12', visible: false, click: run((browser) => browser.toggleDevTools()) }
      ]
    : []

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
    accelerator: keys(`⌃${i + 1}`, `Control+${i + 1}`),
    visible: false,
    click: run((browser) => browser.switchSpaceIndex(i + 1))
  }))

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, click: run((browser) => browser.handle({ type: 'ui.openAbout' })) },
        // About checks for updates as it opens, like Chrome's.
        { label: 'Check for Updates…', click: run((browser) => browser.handle({ type: 'ui.openAbout' })) },
        { type: 'separator' },
        { label: 'Settings…', accelerator: sc('settings'), click: run((browser) => browser.handle({ type: 'ui.openSettings' })) },
        { type: 'separator' },
        ...(linux
          ? []
          : ([
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' }
            ] as const)),
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: sc('newTab'), click: run((browser) => browser.handle({ type: 'ui.openPalette', mode: 'new' })) },
        { label: 'New Window', accelerator: sc('newWindow'), click: () => void hub.openWindow('blank') },
        { label: 'New Private Window', accelerator: sc('newPrivateWindow'), click: () => void hub.openWindow('private') },
        {
          label: 'Open Location…',
          accelerator: sc('openLocation'),
          click: run((browser) => browser.handle({ type: 'ui.openPalette', mode: 'current' }))
        },
        {
          label: 'Open File…',
          accelerator: sc('openFile'),
          click: run((browser) => void browser.openFileDialog())
        },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: sc('closeTab'),
          click: run(
            (browser) => browser.closeActive(),
            (popup) => popup.close()
          )
        },
        {
          label: 'Close Window',
          accelerator: sc('closeWindow'),
          click: run(
            (browser) => browser.window().close(),
            (popup) => popup.close()
          )
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: sc('reopenTab'),
          click: run((browser) => browser.handle({ type: 'tab.reopenClosed' }))
        },
        { type: 'separator' },
        { label: 'Save Page As…', accelerator: sc('savePage'), click: run((browser) => void browser.savePageAs()) },
        { label: 'Export as PDF…', click: run((browser) => void browser.exportPdf()) },
        {
          label: 'Print…',
          accelerator: sc('print'),
          click: run(
            (browser) => browser.printActive(),
            (popup) => popup.webContents.print({}, () => {})
          )
        },
        { type: 'separator' },
        { label: 'Capture…', accelerator: sc('capture'), click: run((browser) => void browser.startCapture()) },
        { type: 'separator' },
        { label: 'Copy Current URL', accelerator: sc('copyUrl'), click: run((browser) => browser.handle({ type: 'ui.copyUrl' })) },
        {
          label: 'Copy URL as Markdown',
          accelerator: sc('copyMarkdown'),
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
        { label: 'Find…', accelerator: sc('find'), click: run((browser) => browser.openFind()) },
        { label: 'Find Next', accelerator: sc('findNext'), click: run((browser) => browser.findAgain(true)) },
        { label: 'Find Previous', accelerator: sc('findPrevious'), click: run((browser) => browser.findAgain(false)) }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload Page',
          accelerator: sc('reload'),
          click: run(
            (browser) => browser.reloadActive(false),
            (popup) => popup.webContents.reload()
          )
        },
        {
          label: 'Reload Ignoring Cache',
          accelerator: sc('hardReload'),
          click: run(
            (browser) => browser.reloadActive(true),
            (popup) => popup.webContents.reloadIgnoringCache()
          )
        },
        { type: 'separator' },
        { label: 'Toggle Compact Mode', accelerator: sc('compact'), click: run((browser) => browser.handle({ type: 'ui.toggleCompact' })) },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: sc('zoomIn'), click: run((browser) => browser.zoomActive(1)) },
        ...alias('zoomIn', {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          visible: false,
          click: run((browser) => browser.zoomActive(1))
        }),
        { label: 'Zoom Out', accelerator: sc('zoomOut'), click: run((browser) => browser.zoomActive(-1)) },
        { label: 'Actual Size', accelerator: sc('actualSize'), click: run((browser) => browser.zoomActive(0)) },
        { type: 'separator' },
        { label: 'Reader Mode', accelerator: sc('reader'), click: run((browser) => browser.handle({ type: 'page.reader' })) },
        { label: 'View Page Source', accelerator: sc('viewSource'), click: run((browser) => browser.viewSource()) },
        { label: 'Summarise or Ask This Page', accelerator: sc('assistant'), click: run((browser) => browser.openAssistant()) },
        {
          label: 'Developer Tools',
          accelerator: sc('devtools'),
          click: run(
            (browser) => browser.toggleDevTools(),
            (popup) => popup.webContents.toggleDevTools()
          )
        },
        {
          label: 'Inspect Elements',
          accelerator: sc('inspect'),
          click: run((browser) => browser.inspectElementMode())
        },
        {
          label: 'JavaScript Console',
          accelerator: sc('console'),
          click: run(
            (browser) => browser.showConsole(),
            (popup) => popup.webContents.openDevTools()
          )
        },
        // ⌥⇧⌘D: ⌥⌘D is macOS's (hiding the Dock).
        {
          label: 'Developer Mode for This Site',
          accelerator: sc('developerMode'),
          click: run((browser) => browser.toggleDeveloperForActive())
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
        { role: 'togglefullscreen' },
        ...linuxExtras
      ]
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: sc('back'), click: run((browser) => browser.handle({ type: 'nav.back' })) },
        { label: 'Forward', accelerator: sc('forward'), click: run((browser) => browser.handle({ type: 'nav.forward' })) },
        { type: 'separator' },
        {
          label: 'Show All History',
          accelerator: sc('history'),
          click: run((browser) => browser.handle({ type: 'ui.openHistory' }))
        },
        {
          label: 'Downloads',
          accelerator: sc('downloads'),
          click: run((browser) => browser.handle({ type: 'ui.downloads' }))
        }
      ]
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Switch to Recent Tab', accelerator: sc('recentTab'), click: run((browser) => browser.cycleRecent(1)) },
        { label: 'Switch to Recent Tab (Back)', accelerator: sc('recentTabBack'), click: run((browser) => browser.cycleRecent(-1)) },
        { label: 'Next Tab', accelerator: sc('nextTab'), click: run((browser) => browser.cycleTab(1)) },
        { label: 'Previous Tab', accelerator: sc('previousTab'), click: run((browser) => browser.cycleTab(-1)) },
        { type: 'separator' },
        { label: 'Pin / Unpin Tab', accelerator: sc('pinTab'), click: run((browser) => browser.togglePinActive()) },
        ...alias('pinTab', {
          label: 'Pin / Unpin Tab',
          accelerator: 'CmdOrCtrl+Shift+D',
          visible: false,
          click: run((browser) => browser.togglePinActive())
        }),
        { label: 'Clear Unpinned Tabs', accelerator: sc('clearTabs'), click: run((browser) => browser.clearActiveSpace()) },
        { type: 'separator' },
        ...tabItems,
        { label: 'Select Last Tab', accelerator: 'CmdOrCtrl+9', visible: false, click: run((browser) => browser.selectTabIndex(9)) },
        ...essentialItems
      ]
    },
    {
      label: 'Split View',
      submenu: [
        { label: 'Add Split Pane', accelerator: sc('addPane'), click: run((browser) => browser.addSplitPane()) },
        { label: 'Remove Split Pane', accelerator: sc('removePane'), click: run((browser) => browser.removeSplitPane()) },
        { type: 'separator' },
        { label: 'Side by Side', accelerator: sc('sideBySide'), click: run((browser) => browser.splitWithLayout('horizontal')) },
        { label: 'Stacked', accelerator: sc('stacked'), click: run((browser) => browser.splitWithLayout('vertical')) },
        { label: 'Grid', accelerator: sc('grid'), click: run((browser) => browser.splitWithLayout('grid')) },
        { type: 'separator' },
        { label: 'Unsplit All', accelerator: sc('unsplit'), click: run((browser) => browser.dissolveActiveSplit()) }
      ]
    },
    {
      label: 'Spaces',
      submenu: [
        { label: 'Next Space', accelerator: sc('nextSpace'), click: run((browser) => browser.switchSpaceRelative(1)) },
        {
          label: 'Previous Space',
          accelerator: sc('previousSpace'),
          click: run((browser) => browser.switchSpaceRelative(-1))
        },
        ...spaceItems
      ]
    },
    // Linux's Window menu would add Close with Ctrl+W, which is Close Tab here.
    linux ? { label: 'Window', submenu: [{ role: 'minimize' }] } : { role: 'windowMenu' }
  ]
  return Menu.buildFromTemplate(template)
}
