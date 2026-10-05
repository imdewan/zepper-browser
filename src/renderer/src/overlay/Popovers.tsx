import { useEffect } from 'react'
import { motion } from 'motion/react'
import type { PopoverSpec, Space } from '@shared/types'
import { zepper } from '../bridge'
import { SPACE_EMOJI } from '../emoji'
import { GradientEditor } from '../GradientEditor'
import { cx } from '../util'
import { PermissionPanel, SiteInfoPanel } from './SiteInfo'

interface PopoverProps {
  popover: PopoverSpec
  space: Space | undefined
  onClose: () => void
}

/** Anchored popovers drawn above web content: the space icon and theme pickers. */
export function Popover({ popover, space, onClose }: PopoverProps): React.JSX.Element | null {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const needsSpace = popover.kind === 'emoji' || popover.kind === 'theme'
  if (needsSpace && !space) return null
  const { anchor } = popover
  // Space pickers open beside the sidebar; site panels drop down from their anchor.
  const beside = needsSpace
  const width = popover.kind === 'siteInfo' ? 340 : popover.kind === 'theme' ? 352 : 300
  const left = beside
    ? Math.min(anchor.x + anchor.width + 12, window.innerWidth - width - 12)
    : Math.min(Math.max(12, anchor.x), window.innerWidth - width - 12)
  const estimatedHeight = popover.kind === 'theme' ? 600 : 420
  const top = beside
    ? Math.max(12, Math.min(anchor.y - 8, window.innerHeight - estimatedHeight - 12))
    : anchor.y + anchor.height + 8

  return (
    <div className="popover-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div
        className={cx('popover', `popover-${popover.kind}`)}
        style={{ left, top, width }}
        initial={beside ? { opacity: 0, scale: 0.96, x: -6 } : { opacity: 0, scale: 0.97, y: -6 }}
        animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
        transition={{ type: 'spring', bounce: 0.15, duration: 0.3 }}
      >
        {popover.kind === 'emoji' && space && (
          <EmojiPicker
            selected={space.icon}
            onPick={(icon) => {
              zepper.send({ type: 'space.update', spaceId: space.id, patch: { icon } })
              onClose()
            }}
          />
        )}
        {popover.kind === 'theme' && space && (
          <>
            <div className="popover-title">{space.icon} {space.name} theme</div>
            <GradientEditor
              theme={space.theme}
              onChange={(theme) => zepper.send({ type: 'space.update', spaceId: space.id, patch: { theme } })}
            />
          </>
        )}
        {popover.kind === 'siteInfo' && <SiteInfoPanel info={popover.info} onClose={onClose} />}
        {popover.kind === 'permission' && <PermissionPanel prompt={popover.prompt} onDone={onClose} />}
      </motion.div>
    </div>
  )
}

function EmojiPicker({ selected, onPick }: { selected: string; onPick: (emoji: string) => void }): React.JSX.Element {
  return (
    <>
      <div className="popover-title">Space icon</div>
      <div className="emoji-grid">
        {SPACE_EMOJI.map((emoji) => (
          <button key={emoji} className={cx('emoji-cell', emoji === selected && 'selected')} onClick={() => onPick(emoji)}>
            {emoji}
          </button>
        ))}
      </div>
    </>
  )
}

