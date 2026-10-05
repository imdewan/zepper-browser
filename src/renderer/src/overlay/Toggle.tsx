import { motion } from 'motion/react'
import { cx } from '../util'

interface ToggleProps {
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  /** A smaller switch, for lists of options. */
  small?: boolean
}

/** An iOS-style switch. */
export function Toggle({ checked, onChange, disabled = false, small = false }: ToggleProps): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cx('toggle', checked && 'on', small && 'small')}
      onClick={() => onChange(!checked)}
    >
      <motion.span className="toggle-knob" layout transition={{ type: 'spring', bounce: 0.25, duration: 0.3 }} />
    </button>
  )
}
