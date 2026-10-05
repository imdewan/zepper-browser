import { useState } from 'react'
import { motion } from 'motion/react'
import { THEME_PRESETS, themeBackground } from '@shared/theme'
import type { SpaceTheme } from '@shared/types'
import { zepper } from '../bridge'
import { SPACE_EMOJI } from '../emoji'
import { cx } from '../util'

interface SpaceCreateProps {
  onDone: () => void
}

/** Zen-style inline "Create a Space" form that slides into the sidebar. */
export function SpaceCreate({ onDone }: SpaceCreateProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('✨')
  const [theme, setTheme] = useState<SpaceTheme>(THEME_PRESETS[0])
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
      <div className="swatches">
        {THEME_PRESETS.map((preset, i) => (
          <button
            type="button"
            key={i}
            className={cx('swatch', preset === theme && 'selected', preset.colors.length === 0 && 'swatch-default')}
            style={{ background: preset.colors.length ? themeBackground({ ...preset, opacity: 1 }) : undefined }}
            title={preset.colors.length ? preset.colors.join(' · ') : 'Default'}
            onClick={() => setTheme(preset)}
          />
        ))}
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
