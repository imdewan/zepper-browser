import { useEffect } from 'react'
import { motion } from 'motion/react'
import type { PopoverSpec, Snapshot, Space } from '@shared/types'
import { zepper } from '../bridge'
import { SPACE_EMOJI } from '../emoji'
import { GradientEditor } from '../GradientEditor'
import { IconClose } from '../icons'
import { cx } from '../util'
import { AssistantPanel } from './AssistantPanel'
import { AuthDialog, JsDialog } from './Dialogs'
import { ExtensionsPanel } from './ExtensionsPanel'
import { PermissionPanel, SiteInfoPanel, WidevinePrompt } from './SiteInfo'
import { SpacesPicker } from './SpacesPicker'

const POPOVER_WIDTHS: Partial<Record<PopoverSpec['kind'], number>> = {
  jsDialog: 420,
  auth: 360,
  widevine: 360,
  siteInfo: 340,
  assistant: 400,
  theme: 352
}

interface PopoverProps {
  popover: PopoverSpec
  space: Space | undefined
  snapshot: Snapshot | null
  pinnedExtensions: string[]
  onClose: () => void
}

/** Anchored popovers drawn above web content: the space icon and theme pickers. */
export function Popover({ popover, space, snapshot, pinnedExtensions, onClose }: PopoverProps): React.JSX.Element | null {
  // Page dialogs are modal for their tab: they handle Esc themselves (as "Cancel") and ignore outside clicks.
  const modal = popover.kind === 'jsDialog' || popover.kind === 'auth'
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !modal) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, modal])

  const needsSpace = popover.kind === 'emoji' || popover.kind === 'theme'
  if (needsSpace && !space) return null
  const essentialEmoji = popover.kind === 'emoji' && popover.tabId ? snapshot?.tabs.find((t) => t.id === popover.tabId)?.emoji : null
  const { anchor } = popover
  // Space pickers open beside the sidebar, the extensions panel rises from the bottom bar,
  // and site panels drop down from their anchor.
  const beside = needsSpace
  // Panels from the bottom bar rise above their button; from the top of the window they drop down.
  const above = popover.kind === 'extensions' && anchor.y > window.innerHeight / 2
  const width = popover.kind === 'spaces' ? Math.max(250, anchor.width) : (POPOVER_WIDTHS[popover.kind] ?? 300)
  const left = beside
    ? Math.min(anchor.x + anchor.width + 12, window.innerWidth - width - 12)
    : Math.min(Math.max(12, above ? anchor.x - 6 : anchor.x), window.innerWidth - width - 12)
  const estimatedHeight = popover.kind === 'theme' ? 600 : 420
  // Page dialogs sit centred at the top of the page, like Chrome's.
  const position = modal
    ? { left: Math.max(12, anchor.x + (anchor.width - width) / 2), top: anchor.y + 14, width }
    : above
      ? { left, bottom: window.innerHeight - anchor.y + 8, width }
      : {
          left,
          width,
          top: beside ? Math.max(12, Math.min(anchor.y - 8, window.innerHeight - estimatedHeight - 12)) : anchor.y + anchor.height + 8
        }

  return (
    <div className={cx('popover-backdrop', modal && 'modal')} onMouseDown={(e) => !modal && e.target === e.currentTarget && onClose()}>
      <motion.div
        className={cx('popover', `popover-${popover.kind}`)}
        style={position}
        initial={beside ? { opacity: 0, scale: 0.96, x: -6 } : { opacity: 0, scale: 0.97, y: above ? 6 : -6 }}
        animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
        transition={{ type: 'spring', bounce: 0.15, duration: 0.3 }}
      >
        {!modal && (
          <button
            className="popover-close"
            title={popover.kind === 'permission' ? 'Not now' : 'Close (Esc)'}
            onClick={() => {
              // Closing the Widevine prompt means "not now" (it may ask again later).
              if (popover.kind === 'widevine') zepper.send({ type: 'widevine.respond', host: popover.host, choice: 'later' })
              onClose()
            }}
          >
            <IconClose size={13} />
          </button>
        )}
        {popover.kind === 'emoji' && space && (
          <EmojiPicker
            selected={popover.tabId ? (essentialEmoji ?? '') : space.icon}
            onPick={(icon) => {
              if (popover.tabId) zepper.send({ type: 'tab.setEmoji', tabId: popover.tabId, emoji: icon })
              else zepper.send({ type: 'space.update', spaceId: space.id, patch: { icon } })
              onClose()
            }}
          />
        )}
        {popover.kind === 'theme' && space && (
          <>
            <div className="popover-title">
              {space.icon} {space.name} theme
            </div>
            <GradientEditor
              theme={space.theme}
              onChange={(theme) => zepper.send({ type: 'space.update', spaceId: space.id, patch: { theme } })}
            />
          </>
        )}
        {popover.kind === 'siteInfo' && <SiteInfoPanel info={popover.info} onClose={onClose} />}
        {popover.kind === 'permission' && <PermissionPanel prompt={popover.prompt} onDone={onClose} />}
        {popover.kind === 'extensions' && <ExtensionsPanel pinned={pinnedExtensions} anchor={anchor} onClose={onClose} />}
        {popover.kind === 'spaces' && snapshot && <SpacesPicker snapshot={snapshot} onClose={onClose} />}
        {popover.kind === 'widevine' && <WidevinePrompt host={popover.host} restart={popover.restart} onDone={onClose} />}
        {popover.kind === 'assistant' && <AssistantPanel title={popover.title} host={popover.host} />}
        {popover.kind === 'jsDialog' && <JsDialog key={popover.dialog.id} dialog={popover.dialog} onDone={onClose} />}
        {popover.kind === 'auth' && <AuthDialog key={popover.auth.id} auth={popover.auth} onDone={onClose} />}
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
