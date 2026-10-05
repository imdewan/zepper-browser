import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { Suggestion } from '@shared/types'
import { zepper } from '../bridge'
import { Favicon } from '../Favicon'
import { IconArrowRight, IconClock, IconGlobe, IconSearch } from '../icons'
import { cx, hostOf } from '../util'

/** Typed text survives closing the palette for 45 seconds, like Zen. */
const KEEP_TYPED_MS = 45_000
let lastTyped = { text: '', at: 0 }

interface PaletteProps {
  mode: 'new' | 'current' | 'split'
  currentUrl: string | null
  onClose: () => void
}

export function Palette({ mode, currentUrl, onClose }: PaletteProps): React.JSX.Element {
  const initial = currentUrl ?? (Date.now() - lastTyped.at < KEEP_TYPED_MS ? lastTyped.text : '')
  const [text, setText] = useState(initial)
  const [results, setResults] = useState<Suggestion[]>([])
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const request = useRef(0)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  useEffect(() => {
    const id = ++request.current
    const query = text === currentUrl ? '' : text
    const timer = setTimeout(async () => {
      const next = await zepper.suggest(query)
      if (id !== request.current) return
      setResults(next)
      setSelected(0)
    }, query ? 35 : 0)
    return () => clearTimeout(timer)
  }, [text, currentUrl])

  useEffect(() => {
    list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const close = (): void => {
    lastTyped = { text: text === currentUrl ? '' : text, at: Date.now() }
    onClose()
  }

  const choose = (suggestion: Suggestion | undefined): void => {
    if (!suggestion) {
      if (!text.trim()) return
      zepper.send({ type: 'tab.open', input: text, where: mode })
    } else if (suggestion.kind === 'tab') {
      zepper.send(mode === 'split' ? { type: 'split.add', tabId: suggestion.tabId } : { type: 'tab.activate', tabId: suggestion.tabId })
    } else {
      const target = suggestion.url || (suggestion.kind === 'search' ? suggestion.query : '')
      zepper.send({ type: 'tab.open', input: target, where: mode })
    }
    lastTyped = { text: '', at: 0 }
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')
    const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')
    if (down || up) {
      e.preventDefault()
      if (results.length) setSelected((s) => (s + (down ? 1 : -1) + results.length) % results.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(results[selected])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  return (
    <motion.div
      className="palette-backdrop"
      initial={{ opacity: 1 }}
      exit={{ opacity: 1 }}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <motion.div
        className="palette"
        initial={{ opacity: 0, scaleX: 0.99, scaleY: 0.98 }}
        animate={{ opacity: 1, scaleX: 1, scaleY: 1 }}
        exit={{ opacity: 0, scale: 0.985, transition: { duration: 0.1 } }}
        transition={{ duration: 0.15, ease: [0.07, 0.95, 0, 1] }}
      >
        <div className="palette-input-row">
          <IconSearch size={18} className="palette-input-icon" />
          <input
            ref={input}
            value={text}
            spellCheck={false}
            placeholder={mode === 'split' ? 'Open in split view…' : mode === 'new' ? 'Search or enter address…' : 'Search or enter address'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        {results.length > 0 && (
          <div className="palette-results" ref={list}>
            {results.map((suggestion, i) => (
              <SuggestionRow
                key={`${suggestion.kind}-${i}`}
                mode={mode}
                suggestion={suggestion}
                selected={i === selected}
                onHover={() => setSelected(i)}
                onChoose={() => choose(suggestion)}
              />
            ))}
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}

interface SuggestionRowProps {
  mode: 'new' | 'current' | 'split'
  suggestion: Suggestion
  selected: boolean
  onHover: () => void
  onChoose: () => void
}

function SuggestionRow({ mode, suggestion, selected, onHover, onChoose }: SuggestionRowProps): React.JSX.Element {
  let icon: React.JSX.Element
  let title: string
  let detail: string | null = null
  let chip: string | null = null

  switch (suggestion.kind) {
    case 'tab':
      icon = <Favicon src={suggestion.favicon} size={16} />
      title = suggestion.title || suggestion.url
      detail = hostOf(suggestion.url)
      chip = mode === 'split' ? 'Split with Tab' : 'Switch to Tab'
      break
    case 'history':
      icon = <IconClock size={16} />
      title = suggestion.title
      detail = hostOf(suggestion.url)
      break
    case 'url':
      icon = <IconGlobe size={16} />
      title = suggestion.url
      chip = 'Open'
      break
    case 'search':
      icon = <IconSearch size={16} />
      title = suggestion.query
      detail = suggestion.fromProvider ? null : 'Search with Google'
      break
  }

  return (
    <div
      className={cx('suggestion', selected && 'selected')}
      data-selected={selected}
      onMouseMove={onHover}
      onMouseDown={(e) => {
        e.preventDefault()
        onChoose()
      }}
    >
      <span className="suggestion-icon">{icon}</span>
      <span className="suggestion-title">{title}</span>
      {detail && <span className="suggestion-detail">— {detail}</span>}
      {chip && (
        <span className="suggestion-chip">
          {chip} <IconArrowRight size={12} />
        </span>
      )}
    </div>
  )
}
