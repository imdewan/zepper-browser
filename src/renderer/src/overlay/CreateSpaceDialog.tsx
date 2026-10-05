import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { DEFAULT_THEME, prefersDarkUi, themeBackground } from '@shared/theme'
import type { ProfileChoice, Space, SpaceTheme } from '@shared/types'
import { zepper } from '../bridge'
import { IconClose } from '../icons'
import { SPACE_EMOJI } from '../emoji'
import { GradientEditor } from '../GradientEditor'
import { cx } from '../util'

interface CreateSpaceDialogProps {
  systemDark: boolean
  /** Existing spaces, to copy or share sign-ins from. */
  spaces: Space[]
  activeSpaceId: string
  onClose: () => void
}

/** Modal "Create a Space" sheet with a live preview of the new space's sidebar. */
export function CreateSpaceDialog({ systemDark, spaces, activeSpaceId, onClose }: CreateSpaceDialogProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('✨')
  const [theme, setTheme] = useState<SpaceTheme>(DEFAULT_THEME)
  const [pickingIcon, setPickingIcon] = useState(false)
  /** 'new', or 'copy:<spaceId>' / 'share:<spaceId>'. */
  const [signIns, setSignIns] = useState('new')
  const previewDark = prefersDarkUi(theme, systemDark)
  // The space you're in comes first.
  const ordered = [...spaces].sort((a, b) => Number(b.id === activeSpaceId) - Number(a.id === activeSpaceId))

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const create = (): void => {
    if (!name.trim()) return
    const [mode, from] = signIns.split(':') as ['new' | 'copy' | 'share', string?]
    const profile: ProfileChoice = mode === 'new' || !from ? { mode: 'new' } : { mode, from }
    zepper.send({ type: 'space.create', name, icon, theme, profile })
    onClose()
  }

  return (
    <motion.div
      className="settings-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.form
        className="create-dialog"
        initial={{ opacity: 0, scale: 0.95, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 8, transition: { duration: 0.15 } }}
        transition={{ type: 'spring', bounce: 0.15, duration: 0.4 }}
        onSubmit={(e) => {
          e.preventDefault()
          create()
        }}
      >
        <button type="button" className="settings-close" title="Close (Esc)" onClick={onClose}>
          <IconClose size={14} />
        </button>
        <div className="create-left">
          <h1>Create a Space</h1>
          <p className="create-sub">Each space keeps its own tabs, pinned sites, theme and sign-ins.</p>

          <div className="create-preview" data-ui={previewDark ? 'dark' : 'light'}>
            <div className="create-preview-glass" />
            <div className="create-preview-bg" style={{ background: themeBackground(theme) }} />
            <div className="create-preview-content">
              <div className="mock-pill" />
              <div className="mock-essentials">
                <span />
                <span />
                <span />
              </div>
              <div className="mock-header">
                <span className="mock-icon">{icon}</span>
                <span className="mock-name">{name.trim() || 'New Space'}</span>
              </div>
              <div className="mock-tab active">
                <i />
                <b />
              </div>
              <div className="mock-tab">
                <i />
                <b style={{ width: '58%' }} />
              </div>
              <div className="mock-tab">
                <i />
                <b style={{ width: '44%' }} />
              </div>
            </div>
          </div>

          <div className="create-name">
            <button
              type="button"
              className={cx('create-icon', pickingIcon && 'open')}
              onClick={() => setPickingIcon((v) => !v)}
              title="Choose an icon"
            >
              {icon}
            </button>
            <input autoFocus placeholder="Space name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </div>

          {pickingIcon && (
            <div className="emoji-grid create-emoji">
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

          <div className="create-section-title create-signins-title">Sign-ins &amp; site data</div>
          <select className="create-select" value={signIns} onChange={(e) => setSignIns(e.target.value)}>
            <option value="new">Start fresh</option>
            <optgroup label="Copy sign-ins from (stays separate)">
              {ordered.map((s) => (
                <option key={`copy:${s.id}`} value={`copy:${s.id}`}>
                  {s.icon} {s.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Share sign-ins with (always in sync)">
              {ordered.map((s) => (
                <option key={`share:${s.id}`} value={`share:${s.id}`}>
                  {s.icon} {s.name}
                </option>
              ))}
            </optgroup>
          </select>
          <p className="create-note">
            {signIns === 'new'
              ? 'Its own cookies, logins and site data, like a new profile.'
              : signIns.startsWith('copy:')
                ? 'Starts signed in where that space is (cookies are copied), then stays separate.'
                : 'Uses the same cookies, logins and site data as that space.'}{' '}
            History is shared between spaces.
          </p>

          <div className="create-buttons">
            <button type="button" className="panel-button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="panel-button primary" disabled={!name.trim()}>
              Create Space
            </button>
          </div>
        </div>
        <div className="create-right">
          <div className="create-section-title">Theme</div>
          <GradientEditor theme={theme} onChange={setTheme} />
        </div>
      </motion.form>
    </motion.div>
  )
}
