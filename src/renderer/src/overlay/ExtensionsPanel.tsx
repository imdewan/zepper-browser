import type { Rect } from '@shared/types'
import { zepper } from '../bridge'
import { activateExtension, extensionIconUrl, extensionTitle, useExtensions } from '../extensions'
import { IconPin } from '../icons'
import { cx } from '../util'

interface ExtensionsPanelProps {
  pinned: string[]
  /** The puzzle button: popups open from there. */
  anchor: Rect
  onClose: () => void
}

/**
 * Every installed extension. Click to open it, right-click for its options or
 * to remove it, and pin the ones you use to the sidebar's bottom bar.
 */
export function ExtensionsPanel({ pinned, anchor, onClose }: ExtensionsPanelProps): React.JSX.Element {
  const { actions, activeTabId } = useExtensions()
  const togglePin = (id: string): void => {
    const next = pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id]
    zepper.send({ type: 'settings.update', patch: { pinnedExtensions: next } })
  }

  return (
    <div className="extensions-panel">
      <div className="popover-title">Extensions</div>
      {actions.length === 0 ? (
        <p className="extensions-empty">No extensions installed.</p>
      ) : (
        <div className="extensions-list">
          {actions.map((action) => {
            const isPinned = pinned.includes(action.id)
            return (
              <div
                key={action.id}
                role="button"
                className="extension-row"
                onClick={() => {
                  activateExtension(action.id, activeTabId, anchor)
                  onClose()
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  activateExtension(action.id, activeTabId, e.currentTarget, 'contextmenu')
                }}
              >
                <img className="extension-icon" src={extensionIconUrl(action.id, activeTabId)} alt="" draggable={false} />
                <span className="extension-name">{extensionTitle(action, activeTabId)}</span>
                <button
                  className={cx('extension-pin', isPinned && 'pinned')}
                  title={isPinned ? 'Unpin from the sidebar' : 'Pin to the sidebar'}
                  onClick={(e) => {
                    e.stopPropagation()
                    togglePin(action.id)
                  }}
                >
                  <IconPin size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}
      <button
        className="extensions-store"
        onClick={() => {
          zepper.send({ type: 'tab.open', input: 'https://chromewebstore.google.com', where: 'new' })
          onClose()
        }}
      >
        Find extensions in the Chrome Web Store
      </button>
    </div>
  )
}
