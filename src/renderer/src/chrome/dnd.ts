import { useSyncExternalStore } from 'react'
import type { DropTarget } from '@shared/types'
import { zepper } from '../bridge'

/**
 * Drag and drop in the sidebar, Chrome-style: drag tabs and folders to reorder them, into
 * folders, between pinned and normal, onto Essentials, or onto a space. Uses HTML drag and
 * drop; this module tracks what's being dragged and which row shows the drop indicator.
 */

export type DragItem = { kind: 'tab' | 'folder'; id: string }
export type DropPosition = 'before' | 'after' | 'into'

/** Marks drags that come from the sidebar (so links and files dragged in are ignored). */
const MIME = 'application/x-zepper-item'

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
    onDragEnd: () => {
      dragging = null
      setHint(null)
      notify()
    }
  }
}

interface DropOptions {
  /** Unique per drop target. */
  key: string
  /** Where a drop at each position lands; null refuses it. */
  target: (position: DropPosition, item: DragItem) => DropTarget | null
  /** Folders accept drops into them (the middle of the row). */
  into?: boolean
  /** Split horizontally (Essentials tiles) instead of vertically. */
  horizontal?: boolean
  /** The whole element is one target (a space dot, the empty pinned area). */
  whole?: DropPosition
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
        if (!dragging || !e.dataTransfer.types.includes(MIME)) return
        const at = positionAt(e)
        if (!options.target(at, dragging)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        setHint({ key: options.key, position: at })
      },
      onDragLeave: (e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        if (hint?.key === options.key) setHint(null)
      },
      onDrop: (e) => {
        if (!dragging) return
        const target = options.target(positionAt(e), dragging)
        e.preventDefault()
        e.stopPropagation()
        if (target) zepper.send({ type: 'item.drop', item: dragging, target })
        dragging = null
        setHint(null)
        notify()
      }
    }
  }
}
