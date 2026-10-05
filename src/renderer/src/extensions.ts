import { createElement, useEffect, useRef, useState } from 'react'
import { rectOf } from './util'

/** Where Chrome extensions live (see main/extensions.ts). */
export const EXTENSIONS_PARTITION = 'zepper-browsing'

export interface ExtensionAction {
  id: string
  title?: string
  text?: string
  color?: string
  tabs: Record<string, { title?: string; text?: string; color?: string }>
}

interface ExtensionsState {
  activeTabId?: number
  actions: ExtensionAction[]
}

interface ActivateDetails {
  eventType: 'click' | 'contextmenu'
  extensionId: string
  tabId: number
  alignment: string
  anchorRect: { x: number; y: number; width: number; height: number }
}

/** Exposed by electron-chrome-extensions' injectBrowserAction() in our UI preload. */
interface BrowserActionApi {
  getState(partition: string): Promise<ExtensionsState>
  activate(partition: string, details: ActivateDetails): Promise<void>
  addEventListener(name: 'update', listener: (state: ExtensionsState) => void): void
  removeEventListener(name: 'update', listener: (state: ExtensionsState) => void): void
  addObserver(partition: string): void
  removeObserver(partition: string): void
}

const api = (): BrowserActionApi | undefined => (window as unknown as { browserAction?: BrowserActionApi }).browserAction

/** Installed extensions with a toolbar action, kept up to date. */
export function useExtensions(): ExtensionsState {
  const [state, setState] = useState<ExtensionsState>({ actions: [] })
  useEffect(() => {
    const browserAction = api()
    if (!browserAction) return
    const onUpdate = (next: ExtensionsState): void => setState(next)
    browserAction.addEventListener('update', onUpdate)
    browserAction.addObserver(EXTENSIONS_PARTITION)
    void browserAction.getState(EXTENSIONS_PARTITION).then(onUpdate, () => {})
    return () => {
      browserAction.removeEventListener('update', onUpdate)
      browserAction.removeObserver(EXTENSIONS_PARTITION)
    }
  }, [])
  return state
}

export function extensionTitle(action: ExtensionAction, tabId: number | undefined): string {
  return (tabId !== undefined && action.tabs[tabId]?.title) || action.title || action.id
}

export function extensionIconUrl(id: string, tabId: number | undefined): string {
  const params = new URLSearchParams({ tabId: `${tabId ?? -1}`, partition: EXTENSIONS_PARTITION })
  return `crx://extension-icon/${id}/32/2?${params}`
}

/** Opens an extension's popup (or its context menu) anchored to an element or a window rect. */
export function activateExtension(
  id: string,
  tabId: number | undefined,
  anchor: Element | { x: number; y: number; width: number; height: number },
  eventType: 'click' | 'contextmenu' = 'click'
): void {
  const box = anchor instanceof Element ? rectOf(anchor) : anchor
  const rect = { left: box.x, top: box.y, width: box.width, height: box.height }
  void api()?.activate(EXTENSIONS_PARTITION, {
    eventType,
    extensionId: id,
    tabId: tabId ?? -1,
    alignment: 'bottom right',
    anchorRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  })
}

/**
 * A pinned extension's button: the library's own <button is="browser-action">,
 * which draws the icon and badge and opens the popup or context menu. It
 * redraws whenever its attributes are set, so we set them on every update.
 */
export function ExtensionButton({ id, tabId, version }: { id: string; tabId: number | undefined; version: unknown }): React.JSX.Element {
  const host = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const el = document.createElement('button', { is: 'browser-action' })
    el.className = 'extension-button'
    el.setAttribute('partition', EXTENSIONS_PARTITION)
    el.setAttribute('alignment', 'bottom right')
    el.id = id
    button.current = el
    host.current?.appendChild(el)
    return () => el.remove()
  }, [id])

  useEffect(() => {
    button.current?.setAttribute('tab', `${tabId ?? -1}`)
  }, [tabId, version])

  return createElement('span', { ref: host, className: 'extension-slot' })
}
