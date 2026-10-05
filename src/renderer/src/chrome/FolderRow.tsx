import { memo, useCallback, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { Folder, UiEvent } from '@shared/types'
import { zepper } from '../bridge'
import { IconChevronDown, IconFolder, IconFolderOpen } from '../icons'
import { useUiEvents } from '../useSnapshot'
import { cx } from '../util'
import { dragProps, useDrop } from './dnd'
import { dropBeside, type RowPlace } from './TabRow'

interface FolderRowProps {
  folder: Folder
  place: RowPlace
  /** Tabs inside, at any depth (shown while collapsed). */
  count: number
}

/**
 * A folder in a space's pinned area: click to collapse, double-click to
 * rename, drag to move, and drop tabs or folders onto its middle to put them inside.
 */
export const FolderRow = memo(function FolderRow({ folder, place, count }: FolderRowProps): React.JSX.Element {
  const [renaming, setRenaming] = useState(false)
  const clickTimer = useRef(0)
  useUiEvents(
    useCallback(
      (event: UiEvent) => {
        if (event.type === 'folder.startRename' && event.folderId === folder.id) setRenaming(true)
      },
      [folder.id]
    )
  )
  const drop = useDrop({
    key: `folder:${folder.id}`,
    into: true,
    target: (position, item) => {
      if (item.id === folder.id) return null
      if (position === 'into') return { zone: 'pinned', spaceId: place.spaceId, parentId: folder.id, index: folder.items.length }
      return dropBeside(place, position, item)
    }
  })
  const commit = (value: string): void => {
    if (value.trim() && value.trim() !== folder.name) zepper.send({ type: 'folder.update', folderId: folder.id, patch: { name: value } })
    setRenaming(false)
  }

  return (
    <motion.div
      className="tab-wrap"
      style={{ '--depth': place.depth } as React.CSSProperties}
      layout="position"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0, transition: { duration: 0.1 } }}
      transition={{ duration: 0.12, ease: 'easeOut' }}
    >
      <div
        {...(renaming ? {} : dragProps({ kind: 'folder', id: folder.id }))}
        {...drop.props}
        className={cx('tab', 'folder-row', folder.collapsed && 'collapsed', drop.position && `dnd-${drop.position}`)}
        title={folder.name}
        onClick={(e) => {
          // A single click toggles, a moment later, so a double-click can rename instead.
          if (renaming || e.detail > 1) return
          window.clearTimeout(clickTimer.current)
          clickTimer.current = window.setTimeout(
            () => zepper.send({ type: 'folder.update', folderId: folder.id, patch: { collapsed: !folder.collapsed } }),
            200
          )
        }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          window.clearTimeout(clickTimer.current)
          setRenaming(true)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          zepper.send({ type: 'folder.contextMenu', folderId: folder.id })
        }}
      >
        <span className="folder-icon">{folder.collapsed ? <IconFolder size={16} /> : <IconFolderOpen size={16} />}</span>
        {renaming ? (
          <input
            className="folder-name-input"
            defaultValue={folder.name}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(e.currentTarget.value)
              if (e.key === 'Escape') setRenaming(false)
            }}
            onBlur={(e) => commit(e.currentTarget.value)}
          />
        ) : (
          <span className="tab-label">
            <span className="tab-title">{folder.name}</span>
          </span>
        )}
        {folder.collapsed && count > 0 && <span className="folder-count">{count}</span>}
        <IconChevronDown size={12} className="folder-chevron" />
      </div>
    </motion.div>
  )
})
