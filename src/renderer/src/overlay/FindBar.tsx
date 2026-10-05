import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { FindResult } from '@shared/types'
import { zepper } from '../bridge'
import { IconChevronDown, IconClose, IconSearch } from '../icons'

interface FindBarProps {
  result: FindResult
  focusKey: number
  onClose: () => void
}

export function FindBar({ result, focusKey, onClose }: FindBarProps): React.JSX.Element {
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusKey])

  const query = (forward: boolean, findNext: boolean): void =>
    zepper.send({ type: 'find.query', text, forward, findNext })

  return (
    <motion.div
      className="find-bar"
      initial={{ opacity: 0, y: -8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', bounce: 0.15, duration: 0.3 }}
    >
      <IconSearch size={14} className="find-icon" />
      <input
        ref={input}
        value={text}
        placeholder="Find in page"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          zepper.send({ type: 'find.query', text: e.target.value, forward: true, findNext: false })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') query(!e.shiftKey, true)
          if (e.key === 'Escape') onClose()
        }}
      />
      <span className="find-count">{text ? `${result.active} of ${result.matches}` : ''}</span>
      <button className="find-button" title="Previous (⇧⌘G)" disabled={!result.matches} onClick={() => query(false, true)}>
        <IconChevronDown size={15} style={{ transform: 'rotate(180deg)' }} />
      </button>
      <button className="find-button" title="Next (⌘G)" disabled={!result.matches} onClick={() => query(true, true)}>
        <IconChevronDown size={15} />
      </button>
      <button className="find-button" title="Close (Esc)" onClick={onClose}>
        <IconClose size={13} />
      </button>
    </motion.div>
  )
}
