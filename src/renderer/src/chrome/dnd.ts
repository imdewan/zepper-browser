import { useSyncExternalStore } from 'react'
import type { DropTarget } from '@shared/types'
import { zepper } from '../bridge'

/**
 * Drag and drop in the sidebar, Chrome-style: drag tabs and folders to reorder them, into
 * folders, between pinned and normal, onto Essentials, or onto a space; drag a tab to another
 * window's sidebar to move it there, or out of the window for a window of its own. Files and links
 * dropped in open as tabs where they land (or in the tab they're dropped on). Uses HTML drag and
 * drop; this module tracks what's being dragged and which row shows the drop indicator.
 */

export type DragItem = { kind: 'tab' | 'folder'; id: string }
export type DropPosition = 'before' | 'after' | 'into'

/** Marks drags that come from a sidebar (this window's, or another's). */
const MIME = 'application/x-zepper-item'
/** A tab from another window's sidebar: what it is only arrives with the drop. */
const ELSEWHERE: DragItem = { kind: 'tab', id: '' }

/** What's being dragged over: one of this sidebar's items, another window's, or files and links. */
function incoming(e: React.DragEvent<HTMLElement>): 'item' | 'elsewhere' | 'external' | null {
  const types = e.dataTransfer.types
  if (types.includes(MIME)) return dragging ? 'item' : 'elsewhere'
  if (types.includes('Files') || types.includes('text/uri-list')) return 'external'
  return null
}

/** The files (as file: addresses) and links in a drop. */
function droppedUrls(data: DataTransfer): string[] {
  const files = Array.from(data.files)
    .map((file) => zepper.pathForFile(file))
    .filter(Boolean)
    .map((path) => `file://${path.split('/').map(encodeURIComponent).join('/')}`)
  if (files.length > 0) return files
  return data
    .getData('text/uri-list')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

/** The middle of a row: a file or link dropped there opens in that tab rather than beside it. */
const middle = (e: React.DragEvent<HTMLElement>): boolean => {
  const rect = e.currentTarget.getBoundingClientRect()
  const ratio = (e.clientY - rect.top) / rect.height
  return ratio > 0.25 && ratio < 0.75
}

let dragging: DragItem | null = null
let hint: { key: string; position: DropPosition } | null = null
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((l) => l())
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function setHint(next: typeof hint): void {
  if (next?.key === hint?.key && next?.position === hint?.position) return
  hint = next
  notify()
}

/** What's being dragged right now (null when nothing). */
export function useDragging(): DragItem | null {
  return useSyncExternalStore(subscribe, () => dragging)
}

/** Props that make an element draggable as a tab or folder. */
export function dragProps(item: DragItem): Pick<React.HTMLAttributes<HTMLElement>, 'draggable' | 'onDragStart' | 'onDragEnd'> {
  return {
    draggable: true,
    onDragStart: (e) => {
      dragging = item
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData(MIME, JSON.stringify(item))
      notify()
    },
    onDragEnd: (e) => {
      // Let go where nothing took it (outside the sidebar): the tab gets a window of its own, or
      // joins the window it was let go over. Zepper checks where the pointer is.
      if (item.kind === 'tab' && e.dataTransfer.dropEffect === 'none') zepper.send({ type: 'tab.tearOff', tabId: item.id })
      dragging = null
      setHint(null)
      notify()
    }
  }
}

interface DropOptions {
  /** Unique per drop target. */
  key: string
  /** Where a drop at each position lands; null refuses it. The event is there for targets that work it out from the pointer. */
  target: (position: DropPosition, item: DragItem, event: React.DragEvent<HTMLElement>) => DropTarget | null
  /** Which element shows the indicator, when that isn't this one (a grid pointing at one of its tiles). */
  hint?: (event: React.DragEvent<HTMLElement>) => { key: string; position: DropPosition } | null
  /** Folders accept drops into them (the middle of the row). */
  into?: boolean
  /** Split horizontally (Essentials tiles) instead of vertically. */
  horizontal?: boolean
  /** The whole element is one target (a space dot, the empty pinned area). */
  whole?: DropPosition
  /** A tab's row: files and links dropped on its middle open in it. */
  onto?: string
}

/** The indicator an element shows for a drop target that points at it (see DropOptions.hint). */
export function useDropHint(key: string): DropPosition | null {
  return useSyncExternalStore(subscribe, () => (hint?.key === key ? hint.position : null))
}

/** Props that make an element a drop target, and which indicator it should show. */
export function useDrop(options: DropOptions): {
  props: Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>
  position: DropPosition | null
} {
  const position = useSyncExternalStore(subscribe, () => (hint?.key === options.key ? hint.position : null))
  const positionAt = (e: React.DragEvent<HTMLElement>): DropPosition => {
    if (options.whole) return options.whole
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = options.horizontal ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height
    if (options.into) return ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'into'
    return ratio < 0.5 ? 'before' : 'after'
  }
  return {
    position,
    props: {
      onDragOver: (e) => {
        const kind = incoming(e)
        if (!kind) return
        const intoTab = kind === 'external' && !!options.onto && middle(e)
        const at = intoTab ? 'into' : positionAt(e)
        if (!intoTab && !options.target(at, kind === 'item' ? dragging! : ELSEWHERE, e)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = kind === 'external' ? 'copy' : 'move'
        setHint(options.hint && !intoTab ? options.hint(e) : { key: options.key, position: at })
      },
      onDragLeave: (e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        if (hint?.key === options.key || options.hint) setHint(null)
      },
      onDrop: (e) => {
        const kind = incoming(e)
        if (!kind) return
        e.preventDefault()
        e.stopPropagation()
        if (kind === 'external') {
          const urls = droppedUrls(e.dataTransfer)
          const intoTab = !!options.onto && middle(e)
          const target = intoTab ? null : options.target(positionAt(e), ELSEWHERE, e)
          if (urls.length > 0 && (intoTab || target))
            zepper.send({ type: 'tab.openDropped', urls, target, ...(intoTab ? { ontoTabId: options.onto } : {}) })
        } else {
          // Another window's tab: what it is comes with the drop.
          let item = dragging
          if (!item) {
            try {
              item = JSON.parse(e.dataTransfer.getData(MIME)) as DragItem
            } catch {
              item = null
            }
          }
          const target = item && options.target(positionAt(e), item, e)
          if (item && target) zepper.send({ type: 'item.drop', item, target })
        }
        dragging = null
        setHint(null)
        notify()
      }
    }
  }
}
