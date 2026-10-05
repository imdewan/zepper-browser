import { motion } from 'motion/react'
import { cx } from '../util'

/** An iOS-style switch. */
export function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }): React.JSX.Element {
  return (
    <button role="switch" aria-checked={checked} className={cx('toggle', checked && 'on')} onClick={() => onChange(!checked)}>
      <motion.span className="toggle-knob" layout transition={{ type: 'spring', bounce: 0.25, duration: 0.3 }} />
    </button>
  )
}
