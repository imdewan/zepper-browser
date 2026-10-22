/**
 * Zepper's shortcuts are written the Mac way (⌘ ⌥ ⇧ ⌃). Elsewhere ⌘ is Ctrl, ⌥ is Alt and ⇧ is Shift,
 * except for the ones that would clash with the desktop or with what Linux browsers use, which take
 * Chrome's Linux shortcuts instead. The menu (its accelerators) and every label use this table.
 */
export const LINUX_SHORTCUTS: Record<string, string> = {
  // Ctrl+Y is Redo; Chrome uses Ctrl+H.
  '⌘Y': 'Ctrl+H',
  // Ctrl+Alt+L locks the screen on several desktops; Chrome uses Ctrl+J.
  '⌥⌘L': 'Ctrl+J',
  // Ctrl+Alt+arrows switch workspaces.
  '⌥⌘↓': 'Ctrl+Page Down',
  '⌥⌘↑': 'Ctrl+Page Up',
  '⌥⌘→': 'Ctrl+Alt+Page Down',
  '⌥⌘←': 'Ctrl+Alt+Page Up',
  // Chrome's DevTools and console.
  '⌥⌘I': 'Ctrl+Shift+I',
  '⌥⌘J': 'Ctrl+Shift+J',
  // Split panes: Ctrl+Shift+= is Ctrl++ (zoom in) on most keyboards.
  '⌃⇧=': 'Ctrl+Alt+=',
  '⌃⇧-': 'Ctrl+Alt+-',
  // Spaces: Ctrl+1–9 are tabs.
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`⌃${i + 1}`, `Ctrl+Alt+${i + 1}`]))
}

const MODIFIERS: Record<string, string> = { '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift', '⌘': 'Ctrl' }
const ORDER = ['Ctrl', 'Alt', 'Shift']

/** A shortcut as this platform writes it: "⇧⌘T" on a Mac, "Ctrl+Shift+T" on Linux. Lists ("⌘W / ⇧⌘W") too. */
export function shortcutLabel(mac: string, platform: string): string {
  if (platform === 'darwin') return mac
  // Modifiers, then one key: a named one or a single character ("(⌘[)", "⌥⇧⌘D, from…").
  return mac.replace(/[⌃⌥⇧⌘]+(?:Tab|Return|Space|Delete|Esc|F\d{1,2}|\S)/gu, (keys) => {
    const known = LINUX_SHORTCUTS[keys.replace('−', '-')]
    if (known) return known
    const held = new Set<string>()
    let i = 0
    while (i < keys.length && MODIFIERS[keys[i]]) held.add(MODIFIERS[keys[i++]])
    const key = keys.slice(i).replace('−', '-').replace('⇥', 'Tab')
    return [...ORDER.filter((m) => held.has(m)), key.length === 1 ? key.toUpperCase() : key].join('+')
  })
}

/**
 * The menu's accelerator for a shortcut written the Mac way, on Linux: the table's, in Electron's
 * spelling ("Ctrl+Page Down" is "Ctrl+PageDown"), or null to keep the menu's own (CmdOrCtrl…).
 */
export function linuxAccelerator(mac: string): string | null {
  return LINUX_SHORTCUTS[mac]?.replace('Page Down', 'PageDown').replace('Page Up', 'PageUp') ?? null
}

/** A command you can give your own shortcut to (Settings › Shortcuts). */
export interface ShortcutCommand {
  id: string
  label: string
  /** The menu it's in, for grouping in Settings. */
  group: string
  /** Its shortcut written the Mac way (see LINUX_SHORTCUTS for Linux's). */
  mac: string
}

/** Every command with a shortcut you can change, in the menus' order. */
export const SHORTCUT_COMMANDS: ShortcutCommand[] = [
  { id: 'settings', label: 'Settings', group: 'Zepper', mac: '⌘,' },
  { id: 'newTab', label: 'New Tab', group: 'File', mac: '⌘T' },
  { id: 'newWindow', label: 'New Window', group: 'File', mac: '⌘N' },
  { id: 'newPrivateWindow', label: 'New Private Window', group: 'File', mac: '⇧⌘N' },
  { id: 'openLocation', label: 'Open Location', group: 'File', mac: '⌘L' },
  { id: 'openFile', label: 'Open File', group: 'File', mac: '⌘O' },
  { id: 'closeTab', label: 'Close Tab', group: 'File', mac: '⌘W' },
  { id: 'closeWindow', label: 'Close Window', group: 'File', mac: '⇧⌘W' },
  { id: 'reopenTab', label: 'Reopen Closed Tab', group: 'File', mac: '⇧⌘T' },
  { id: 'savePage', label: 'Save Page As', group: 'File', mac: '⇧⌘S' },
  { id: 'print', label: 'Print', group: 'File', mac: '⌘P' },
  { id: 'capture', label: 'Capture', group: 'File', mac: '⇧⌘2' },
  { id: 'copyUrl', label: 'Copy Current URL', group: 'File', mac: '⇧⌘C' },
  { id: 'copyMarkdown', label: 'Copy URL as Markdown', group: 'File', mac: '⌥⇧⌘C' },
  { id: 'find', label: 'Find', group: 'Edit', mac: '⌘F' },
  { id: 'findNext', label: 'Find Next', group: 'Edit', mac: '⌘G' },
  { id: 'findPrevious', label: 'Find Previous', group: 'Edit', mac: '⇧⌘G' },
  { id: 'reload', label: 'Reload Page', group: 'View', mac: '⌘R' },
  { id: 'hardReload', label: 'Reload Ignoring Cache', group: 'View', mac: '⇧⌘R' },
  { id: 'compact', label: 'Toggle Compact Mode', group: 'View', mac: '⌘S' },
  { id: 'zoomIn', label: 'Zoom In', group: 'View', mac: '⌘+' },
  { id: 'zoomOut', label: 'Zoom Out', group: 'View', mac: '⌘-' },
  { id: 'actualSize', label: 'Actual Size', group: 'View', mac: '⌘0' },
  { id: 'reader', label: 'Reader Mode', group: 'View', mac: '⌥⌘R' },
  { id: 'viewSource', label: 'View Page Source', group: 'View', mac: '⌥⌘U' },
  { id: 'assistant', label: 'Summarise or Ask This Page', group: 'View', mac: '⇧⌘A' },
  { id: 'devtools', label: 'Developer Tools', group: 'View', mac: '⌥⌘I' },
  { id: 'inspect', label: 'Inspect Elements', group: 'View', mac: '⌥⌘C' },
  { id: 'console', label: 'JavaScript Console', group: 'View', mac: '⌥⌘J' },
  { id: 'developerMode', label: 'Developer Mode for This Site', group: 'View', mac: '⌥⇧⌘D' },
  { id: 'back', label: 'Back', group: 'History', mac: '⌘[' },
  { id: 'forward', label: 'Forward', group: 'History', mac: '⌘]' },
  { id: 'history', label: 'Show All History', group: 'History', mac: '⌘Y' },
  { id: 'downloads', label: 'Downloads', group: 'History', mac: '⌥⌘L' },
  { id: 'recentTab', label: 'Switch to Recent Tab', group: 'Tabs', mac: '⌃⇥' },
  { id: 'recentTabBack', label: 'Switch to Recent Tab (Back)', group: 'Tabs', mac: '⌃⇧⇥' },
  { id: 'nextTab', label: 'Next Tab', group: 'Tabs', mac: '⌥⌘↓' },
  { id: 'previousTab', label: 'Previous Tab', group: 'Tabs', mac: '⌥⌘↑' },
  { id: 'pinTab', label: 'Pin / Unpin Tab', group: 'Tabs', mac: '⌘D' },
  { id: 'clearTabs', label: 'Clear Unpinned Tabs', group: 'Tabs', mac: '⇧⌘K' },
  { id: 'addPane', label: 'Add Split Pane', group: 'Split View', mac: '⌃⇧=' },
  { id: 'removePane', label: 'Remove Split Pane', group: 'Split View', mac: '⌃⇧-' },
  { id: 'sideBySide', label: 'Side by Side', group: 'Split View', mac: '⌥⌘V' },
  { id: 'stacked', label: 'Stacked', group: 'Split View', mac: '⌥⇧⌘H' },
  { id: 'grid', label: 'Grid', group: 'Split View', mac: '⌥⌘G' },
  { id: 'unsplit', label: 'Unsplit All', group: 'Split View', mac: '⌥⇧⌘U' },
  { id: 'nextSpace', label: 'Next Space', group: 'Spaces', mac: '⌥⌘→' },
  { id: 'previousSpace', label: 'Previous Space', group: 'Spaces', mac: '⌥⌘←' }
]

const MAC_KEYS: Record<string, string> = {
  '+': 'Plus',
  '−': '-',
  '⇥': 'Tab',
  '↩': 'Return',
  '⌫': 'Backspace',
  '⌦': 'Delete',
  '⎋': 'Escape',
  '↑': 'Up',
  '↓': 'Down',
  '←': 'Left',
  '→': 'Right'
}

/** A shortcut written the Mac way as an accelerator ("⇧⌘T" is "CmdOrCtrl+Shift+T"). */
export function macToAccelerator(mac: string): string {
  const parts: string[] = []
  let i = 0
  const held = new Set<string>()
  while (i < mac.length && '⌃⌥⇧⌘'.includes(mac[i])) held.add(mac[i++])
  if (held.has('⌘')) parts.push('CmdOrCtrl')
  if (held.has('⌃')) parts.push('Control')
  if (held.has('⌥')) parts.push('Alt')
  if (held.has('⇧')) parts.push('Shift')
  const key = mac.slice(i)
  parts.push(MAC_KEYS[key] ?? (key.length === 1 ? key.toUpperCase() : key))
  return parts.join('+')
}

/** A command's own shortcut on this platform, as an accelerator. */
export function defaultAccelerator(command: ShortcutCommand, platform: string): string {
  return (platform === 'linux' && linuxAccelerator(command.mac)) || macToAccelerator(command.mac)
}

/**
 * A command's shortcut with your changes (Settings › Shortcuts): an accelerator, or null when you
 * took it off.
 */
export function acceleratorFor(id: string, custom: Record<string, string>, platform: string): string | null {
  if (id in custom) return custom[id] || null
  const command = SHORTCUT_COMMANDS.find((c) => c.id === id)
  return command ? defaultAccelerator(command, platform) : null
}

const LABEL_KEYS: Record<string, string> = {
  Plus: '+',
  Tab: '⇥',
  Return: '↩',
  Enter: '↩',
  Backspace: '⌫',
  Delete: '⌦',
  Escape: '⎋',
  Space: 'Space',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  PageUp: '⇞',
  PageDown: '⇟',
  Home: '↖',
  End: '↘'
}

/** An accelerator as this platform writes it: "⇧⌘T" on a Mac, "Ctrl+Shift+T" on Linux. */
export function acceleratorLabel(accelerator: string, platform: string): string {
  const parts = accelerator.split('+').filter(Boolean)
  // "CmdOrCtrl++" splits to an empty last part: the key is the plus.
  const key = accelerator.endsWith('++') ? 'Plus' : (parts.pop() ?? '')
  const mods = new Set(parts.map((p) => p.toLowerCase()))
  const cmd = mods.has('cmdorctrl') || mods.has('commandorcontrol') || mods.has('command') || mods.has('cmd')
  const ctrl = mods.has('control') || mods.has('ctrl')
  const alt = mods.has('alt') || mods.has('option')
  const shift = mods.has('shift')
  if (platform === 'darwin') {
    return `${ctrl ? '⌃' : ''}${alt ? '⌥' : ''}${shift ? '⇧' : ''}${cmd ? '⌘' : ''}${LABEL_KEYS[key] ?? key}`
  }
  const names = { Plus: '+', PageUp: 'Page Up', PageDown: 'Page Down', Return: 'Enter' } as Record<string, string>
  return [cmd || ctrl ? 'Ctrl' : '', alt ? 'Alt' : '', shift ? 'Shift' : '', names[key] ?? key].filter(Boolean).join('+')
}

/**
 * The keys an accelerator means on this platform, written the same way however it was spelled, to
 * tell whether two shortcuts are the same keys: on Linux ⌘ and ⌃ are both Ctrl.
 */
export function chordOf(accelerator: string, platform: string): string {
  const label = acceleratorLabel(accelerator, platform)
  return platform === 'darwin' ? label : label.toLowerCase()
}

/** A shortcut that isn't Zepper's to give: the menus' own (Copy, Quit…), or the system's. */
export interface ReservedShortcut {
  accelerator: string
  label: string
  /** The system's (it may never reach Zepper) rather than one of Zepper's fixed ones. */
  system?: boolean
}

/** Shortcuts you can't give a command: the menus' built-in ones, and (as warnings) the system's. */
export function reservedShortcuts(platform: string): ReservedShortcut[] {
  const mac = platform === 'darwin'
  const fixed: ReservedShortcut[] = [
    { accelerator: 'CmdOrCtrl+Z', label: 'Undo' },
    { accelerator: 'CmdOrCtrl+Shift+Z', label: 'Redo' },
    { accelerator: 'CmdOrCtrl+X', label: 'Cut' },
    { accelerator: 'CmdOrCtrl+C', label: 'Copy' },
    { accelerator: 'CmdOrCtrl+V', label: 'Paste' },
    { accelerator: 'CmdOrCtrl+Alt+Shift+V', label: 'Paste and Match Style' },
    { accelerator: 'CmdOrCtrl+A', label: 'Select All' },
    { accelerator: 'CmdOrCtrl+Q', label: 'Quit' },
    ...Array.from({ length: 9 }, (_, i) => ({ accelerator: `CmdOrCtrl+${i + 1}`, label: i === 8 ? 'Last Tab' : `Tab ${i + 1}` })),
    ...Array.from({ length: 9 }, (_, i) => ({ accelerator: `Alt+${i + 1}`, label: `Essential ${i + 1}` })),
    ...Array.from({ length: 9 }, (_, i) => ({
      accelerator: mac ? `Control+${i + 1}` : `Control+Alt+${i + 1}`,
      label: `Space ${i + 1}`
    }))
  ]
  if (mac) {
    fixed.push(
      { accelerator: 'CmdOrCtrl+H', label: 'Hide Zepper' },
      { accelerator: 'CmdOrCtrl+Alt+H', label: 'Hide Others' },
      { accelerator: 'CmdOrCtrl+M', label: 'Minimize' },
      { accelerator: 'Control+CmdOrCtrl+F', label: 'Full Screen' },
      { accelerator: 'CmdOrCtrl+Tab', label: 'the app switcher', system: true },
      { accelerator: 'CmdOrCtrl+Space', label: 'Spotlight', system: true },
      { accelerator: 'CmdOrCtrl+`', label: 'switching windows', system: true },
      { accelerator: 'CmdOrCtrl+Shift+3', label: 'screenshots', system: true },
      { accelerator: 'CmdOrCtrl+Shift+4', label: 'screenshots', system: true },
      { accelerator: 'CmdOrCtrl+Shift+5', label: 'screenshots', system: true },
      { accelerator: 'Control+CmdOrCtrl+Q', label: 'locking the screen', system: true },
      { accelerator: 'CmdOrCtrl+Alt+D', label: 'hiding the Dock', system: true },
      { accelerator: 'CmdOrCtrl+Alt+Escape', label: 'Force Quit', system: true },
      { accelerator: 'Control+CmdOrCtrl+Space', label: 'the emoji picker', system: true },
      { accelerator: 'Control+Space', label: 'switching input sources', system: true },
      { accelerator: 'Control+Up', label: 'Mission Control', system: true },
      { accelerator: 'Control+Down', label: 'App Exposé', system: true },
      { accelerator: 'Control+Left', label: 'switching desktops', system: true },
      { accelerator: 'Control+Right', label: 'switching desktops', system: true }
    )
  } else {
    fixed.push(
      { accelerator: 'F5', label: 'Reload' },
      { accelerator: 'F11', label: 'Full Screen' },
      { accelerator: 'F12', label: 'Developer Tools' },
      { accelerator: 'Alt+Left', label: 'Back' },
      { accelerator: 'Alt+Right', label: 'Forward' },
      { accelerator: 'Control+Alt+L', label: 'locking the screen', system: true },
      { accelerator: 'Alt+Tab', label: 'switching windows', system: true },
      { accelerator: 'Alt+F4', label: 'closing windows', system: true }
    )
  }
  return fixed
}

/** What else uses a shortcut: the commands (by id) and the reserved ones that have the same keys. */
export function shortcutClashes(
  accelerator: string,
  except: string,
  custom: Record<string, string>,
  platform: string
): { commands: ShortcutCommand[]; reserved: ReservedShortcut[] } {
  const chord = chordOf(accelerator, platform)
  return {
    commands: SHORTCUT_COMMANDS.filter((c) => {
      if (c.id === except) return false
      const own = acceleratorFor(c.id, custom, platform)
      return own !== null && chordOf(own, platform) === chord
    }),
    reserved: reservedShortcuts(platform).filter((r) => chordOf(r.accelerator, platform) === chord)
  }
}
