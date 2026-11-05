/// <reference lib="dom" />
import { contextBridge } from 'electron'

/**
 * Runs in every service worker before its own scripts, to keep its number off Zepper's icon: page.ts's
 * badgeShim, for service workers. It's a copy because a module two preloads share is built as a separate
 * chunk, which a sandboxed preload can't load.
 */
contextBridge.executeInMainWorld({
  func: () => {
    const proto = Object.getPrototypeOf(navigator) as Navigator
    if (!proto.setAppBadge) return
    const silent = (): Promise<void> => Promise.resolve()
    Object.defineProperty(silent, 'name', { value: 'setAppBadge' })
    Object.defineProperty(silent, 'toString', { value: () => 'function setAppBadge() { [native code] }' })
    proto.setAppBadge = silent
  }
})
