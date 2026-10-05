import { useEffect, useState } from 'react'
import type { Snapshot } from '@shared/types'
import { zepper } from '../bridge'
import { Equalizer, IconCheck, IconPlus } from '../icons'
import { cx, isMac } from '../util'

/** Drop-down from the space header's chevron: every space, the current one checked. Arrows and Return work too. */
export function SpacesPicker({ snapshot, onClose }: { snapshot: Snapshot; onClose: () => void }): React.JSX.Element {
  const { spaces, tabs, activeSpaceId } = snapshot
  const [selected, setSelected] = useState(Math.max(0, spaces.findIndex((s) => s.id === activeSpaceId)))

  const choose = (spaceId: string): void => {
    if (spaceId !== activeSpaceId) zepper.send({ type: 'space.switch', spaceId })
    onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + spaces.length) % spaces.length)
      } else if (e.key === 'Enter' && spaces[selected]) {
        e.preventDefault()
        choose(spaces[selected].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="spaces-picker">
      <div className="popover-title">Spaces</div>
      <div className="spaces-picker-list">
        {spaces.map((space, i) => {
          const count = tabs.filter((t) => t.spaceId === space.id && t.kind !== 'essential').length
          const playing = tabs.some((t) => t.spaceId === space.id && t.audible && !t.muted)
          const active = space.id === activeSpaceId
          return (
            <button
              key={space.id}
              className={cx('spaces-picker-row', active && 'active', i === selected && 'selected')}
              onMouseMove={() => setSelected(i)}
              onClick={() => choose(space.id)}
            >
              <span className="spaces-picker-icon">{space.icon}</span>
              <span className="spaces-picker-name">{space.name}</span>
              {playing && (
                <span className="spaces-picker-audio" title="Playing audio">
                  <Equalizer />
                </span>
              )}
              <span className="spaces-picker-meta">
                {i < 9 ? <kbd>{isMac ? `⌃${i + 1}` : `Ctrl+${i + 1}`}</kbd> : null}
                {count > 0 && <span className="spaces-picker-count">{count}</span>}
              </span>
              <span className="spaces-picker-check">{active && <IconCheck size={14} />}</span>
            </button>
          )
        })}
      </div>
      <button
        className="spaces-picker-new"
        onClick={() => {
          zepper.send({ type: 'ui.createSpace' })
          onClose()
        }}
      >
        <IconPlus size={14} />
        New Space…
      </button>
    </div>
  )
}
