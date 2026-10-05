import { useState } from 'react'
import { motion } from 'motion/react'
import { DEFAULT_THEME } from '@shared/theme'
import type { SpaceTheme } from '@shared/types'
import { zepper } from '../bridge'
import { SPACE_EMOJI } from '../emoji'
import { GradientEditor } from '../GradientEditor'
import { cx } from '../util'

interface SpaceCreateProps {
  onDone: () => void
}

/** Zen-style inline "Create a Space" form that slides into the sidebar. */
export function SpaceCreate({ onDone }: SpaceCreateProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('✨')
  const [theme, setTheme] = useState<SpaceTheme>(DEFAULT_THEME)
  const [pickingIcon, setPickingIcon] = useState(false)

  const create = (): void => {
    if (!name.trim()) return
    zepper.send({ type: 'space.create', name, icon, theme })
    onDone()
  }

  return (
    <motion.form
      className="space-create"
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.15 } }}
      transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
      onSubmit={(e) => {
        e.preventDefault()
        create()
      }}
      onKeyDown={(e) => e.key === 'Escape' && onDone()}
    >
      <h1>Create a Space</h1>
      <p className="space-create-sub">Spaces keep your tabs and sessions organized.</p>

      <div className="space-create-name">
        <button type="button" className="space-create-icon" onClick={() => setPickingIcon((v) => !v)}>
          {icon}
        </button>
        <input autoFocus placeholder="Space Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </div>

      {pickingIcon && (
        <div className="emoji-grid inline">
          {SPACE_EMOJI.map((emoji) => (
            <button
              type="button"
              key={emoji}
              className={cx('emoji-cell', emoji === icon && 'selected')}
              onClick={() => {
                setIcon(emoji)
                setPickingIcon(false)
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      <div className="space-create-label">Theme</div>
      <div className="space-create-theme">
        <GradientEditor theme={theme} onChange={setTheme} />
      </div>

      <div className="space-create-buttons">
        <button type="submit" className="primary-button" disabled={!name.trim()}>
          Create Space
        </button>
        <button type="button" className="ghost-button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </motion.form>
  )
}
