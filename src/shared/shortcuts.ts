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
