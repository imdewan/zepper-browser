import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { Suggestion } from '@shared/types'
import { zepper } from '../bridge'
import { Favicon } from '../Favicon'
import { IconArrowRight, IconClock, IconClose, IconGlobe, IconSearch } from '../icons'
import { cx, hostOf } from '../util'

/** Typed text survives closing the palette for 45 seconds. */
const KEEP_TYPED_MS = 45_000
/** The most rows, once the search engine's suggestions have joined the rest. */
const MAX_RESULTS = 11
let lastTyped = { text: '', at: 0 }

/** Where a choice opens: as the bar was opened for, or (a modifier) a background tab or a new window. */
type Where = 'new' | 'current' | 'split' | 'background' | 'window'

interface PaletteProps {
  mode: 'new' | 'current' | 'split'
  currentUrl: string | null
  onClose: () => void
  /** The chosen search engine's name, for "Search with …". */
  engineName: string
  /** Sidebar width on either side, so the bar centres on the page. */
  insetLeft?: number
  insetRight?: number
}

export function Palette({ mode, currentUrl, engineName, onClose, insetLeft = 0, insetRight = 0 }: PaletteProps): React.JSX.Element {
  // What you typed. A suggestion you arrow to shows in the field instead (see `shown`), as in Chrome.
  const [text, setText] = useState(() => currentUrl ?? (Date.now() - lastTyped.at < KEEP_TYPED_MS ? lastTyped.text : ''))
  // Suggestions arrive a little after typing; `query` says which text they belong to.
  const [{ query: resultsQuery, results }, setResults] = useState<{ query: string | null; results: Suggestion[] }>({
    query: null,
    results: []
  })
  // The row the keyboard is on (Return goes there), and the one under the pointer (just highlighted).
  const [selected, setSelected] = useState(0)
  const [hovered, setHovered] = useState<number | null>(null)
  // After Backspace, the field shows just what you typed until you type again.
  const [noCompletion, setNoCompletion] = useState(false)
  // Asks again (after a suggestion is removed from history).
  const [refresh, setRefresh] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const request = useRef(0)
  const list = useRef<HTMLDivElement>(null)
  /** The text the listed results are for: new text starts again at the top; the same (asked again) keeps your place. */
  const listedFor = useRef<string | null>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  useEffect(() => {
    const id = ++request.current
    const query = text === currentUrl ? '' : text
    const timer = setTimeout(
      async () => {
        // What's on this Mac shows at once; the search engine's suggestions join below when they arrive
        // (a slow network, a page loading, never holds up the rest).
        const next = await zepper.suggest(query)
        if (id !== request.current) return
        setResults({ query, results: next })
        if (query !== listedFor.current) {
          setSelected(0)
          setHovered(null)
        } else setSelected((s) => Math.min(s, Math.max(0, next.length - 1)))
        listedFor.current = query
        const more = query ? await zepper.searchSuggestions(query) : []
        if (id !== request.current || more.length === 0) return
        setResults((current) =>
          current.query === query
            ? { query, results: [...current.results, ...more].slice(0, Math.max(current.results.length, MAX_RESULTS)) }
            : current
        )
      },
      query ? 35 : 0
    )
    return () => clearTimeout(timer)
  }, [text, currentUrl, refresh])

  useEffect(() => {
    list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // The top hit completes what you're typing in the field ("you" → "you|tube.com"), the rest selected,
  // so Return goes there and typing on just replaces it.
  const typed = text === currentUrl ? '' : text
  const top = results[0]
  const completion =
    !noCompletion &&
    resultsQuery === typed &&
    typed.length > 0 &&
    selected === 0 &&
    (top?.kind === 'history' || top?.kind === 'tab' || top?.kind === 'site') &&
    top.completion &&
    top.completion.toLowerCase().startsWith(typed.toLowerCase()) &&
    top.completion.length > typed.length
      ? typed + top.completion.slice(typed.length)
      : null
  // Arrowed to a row below the first: the field shows it (its address, or its search), to go to or edit.
  const arrowed = selected > 0 ? fillText(results[selected]) : null
  const shown = arrowed ?? completion ?? text
  useLayoutEffect(() => {
    const field = input.current
    if (!field) return
    if (completion) field.setSelectionRange(typed.length, completion.length)
    else if (arrowed !== null) field.setSelectionRange(arrowed.length, arrowed.length)
  }, [completion, typed, arrowed])

  const close = (): void => {
    lastTyped = { text: text === currentUrl ? '' : text, at: Date.now() }
    onClose()
  }

  /** Goes where a row (or, with none, what's typed) leads: as the bar was opened for, or as a modifier says. */
  const choose = (suggestion: Suggestion | undefined, where: Where = mode): void => {
    if (suggestion?.kind === 'bang' && suggestion.url === null) {
      // A bang completion: fill it in and keep typing the query.
      setText((t) => t.replace(/(^|\s)!(\S*)$/, `$1!${suggestion.trigger} `))
      setSelected(0)
      input.current?.focus()
      return
    }
    if (!suggestion) {
      if (!text.trim()) return
      zepper.send({ type: 'tab.open', input: text, where })
    } else if (suggestion.kind === 'bang' && suggestion.url) {
      zepper.send({ type: 'tab.open', input: suggestion.url, where })
    } else if (suggestion.kind === 'tab' && where === mode) {
      zepper.send(mode === 'split' ? { type: 'split.add', tabId: suggestion.tabId } : { type: 'tab.activate', tabId: suggestion.tabId })
    } else {
      // An open tab with a modifier (a new tab, a window): its page opens there.
      const target = suggestion.url || (suggestion.kind === 'search' ? suggestion.query : '')
      zepper.send({ type: 'tab.open', input: target, where })
    }
    lastTyped = { text: '', at: 0 }
    onClose()
  }

  /** Takes a page out of your history, and out of the list (⇧Delete, or its ✕). */
  const remove = (index: number): void => {
    const suggestion = results[index]
    if (suggestion?.kind !== 'history') return
    zepper.send({ type: 'history.remove', url: suggestion.url })
    setResults((current) => ({ ...current, results: current.results.filter((s) => s !== suggestion) }))
    setSelected((s) => (s > index ? s - 1 : Math.min(s, results.length - 2)))
    setHovered(null)
    setRefresh((n) => n + 1)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // Still choosing characters (Japanese, Chinese…): the keys are the input method's.
    if (e.nativeEvent.isComposing) return
    // Tab and Shift-Tab step through suggestions too, as in Chrome and Firefox.
    const tab = e.key === 'Tab' && results.length > 0
    const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n') || (tab && !e.shiftKey)
    const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p') || (tab && e.shiftKey)
    // ⇧Delete takes the highlighted page out of your history, as in Chrome.
    if ((e.key === 'Backspace' || e.key === 'Delete') && e.shiftKey && results[selected]?.kind === 'history') {
      e.preventDefault()
      remove(selected)
      return
    }
    // With just the suggested part selected (as it is when it appears), Backspace removes the suggestion
    // and keeps what you typed. Any other selection (⌘A, say) is deleted as usual, in onChange.
    if ((e.key === 'Backspace' || e.key === 'Delete') && completion) {
      const field = e.currentTarget as HTMLInputElement
      if (field.selectionStart === typed.length && field.selectionEnd === completion.length) {
        e.preventDefault()
        setNoCompletion(true)
        return
      }
    }
    if (completion && (e.key === 'ArrowRight' || e.key === 'End')) {
      // Take the completion as typed.
      e.preventDefault()
      setText(completion)
      return
    }
    if (down || up) {
      e.preventDefault()
      // Past either end it comes round again, as in Chrome.
      if (results.length) setSelected((s) => (s + (down ? 1 : -1) + results.length) % results.length)
    } else if ((e.key === 'PageDown' || e.key === 'PageUp') && results.length) {
      e.preventDefault()
      setSelected(e.key === 'PageDown' ? results.length - 1 : 0)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // As in Chrome: ⌘ opens it in a background tab, ⌥ in a new tab, ⇧ in a new window.
      const where: Where = e.metaKey ? 'background' : e.shiftKey ? 'window' : e.altKey && mode === 'current' ? 'new' : mode
      // ⌃Return makes a name an address: "example" goes to www.example.com.
      const name = typed.trim()
      if (e.ctrlKey && selected === 0 && /^[a-z0-9-]+$/i.test(name)) {
        zepper.send({ type: 'tab.open', input: `https://www.${name}.com/`, where })
        lastTyped = { text: '', at: 0 }
        onClose()
        return
      }
      // Typed faster than suggestions came back: go with what was typed, unless a row was picked.
      const stale = resultsQuery !== typed
      choose(stale && selected === 0 ? undefined : results[selected], where)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      // As in Chrome: Esc first takes back a suggestion you arrowed to, then closes.
      if (selected !== 0) setSelected(0)
      else close()
    }
  }

  return (
    <motion.div
      className="palette-backdrop"
      style={{ paddingLeft: insetLeft, paddingRight: insetRight }}
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
            value={shown}
            spellCheck={false}
            placeholder={mode === 'split' ? 'Open in split view…' : mode === 'new' ? 'Search or enter address…' : 'Search or enter address'}
            onChange={(e) => {
              const value = e.target.value
              // Editing a suggestion you arrowed to makes it what you typed (as in Chrome).
              const editing = arrowed ?? typed
              // Typing more brings the completion back; deleting keeps it away until you type again.
              setNoCompletion(value.length <= editing.length)
              setText(value)
              setSelected(0)
            }}
            onKeyDown={onKeyDown}
          />
          <button className="palette-close" title="Close (Esc)" onMouseDown={(e) => e.preventDefault()} onClick={close}>
            <IconClose size={14} />
          </button>
        </div>
        {results.length > 0 && (
          <div className="palette-results" ref={list} onMouseLeave={() => setHovered(null)}>
            {results.map((suggestion, i) => {
              const group = 'group' in suggestion ? suggestion.group : undefined
              const previous = results[i - 1]
              const startsGroup = group && (!previous || !('group' in previous) || previous.group !== group)
              return (
                <Fragment key={`${suggestion.kind}-${i}`}>
                  {startsGroup && <div className="palette-group">{group === 'recent' ? 'Recent tabs' : 'Frequently visited'}</div>}
                  <SuggestionRow
                    mode={mode}
                    suggestion={suggestion}
                    selected={i === selected}
                    hovered={i === hovered}
                    engineName={engineName}
                    onHover={() => setHovered(i)}
                    onChoose={(where) => choose(suggestion, where)}
                    onRemove={() => remove(i)}
                  />
                </Fragment>
              )
            })}
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}

interface SuggestionRowProps {
  mode: 'new' | 'current' | 'split'
  suggestion: Suggestion
  /** The keyboard's row. */
  selected: boolean
  /** Under the pointer (a lighter highlight; Return still goes to the keyboard's row). */
  hovered: boolean
  engineName: string
  onHover: () => void
  /** Clicked: where to open it (a middle click: a background tab). */
  onChoose: (where?: Where) => void
  /** Take this page out of your history. */
  onRemove: () => void
}

/** What → puts in the field for a suggestion: a search's words, or a page's address (without https://). */
function fillText(suggestion: Suggestion | undefined): string | null {
  if (!suggestion) return null
  if (suggestion.kind === 'search') return suggestion.query
  // A bang being typed has its own completion (Return); → leaves it alone.
  if (suggestion.kind === 'bang') return null
  return suggestion.url.replace(/^https:\/\//, '')
}

function SuggestionRow({
  mode,
  suggestion,
  selected,
  hovered,
  engineName,
  onHover,
  onChoose,
  onRemove
}: SuggestionRowProps): React.JSX.Element {
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
      // A site (the top hit, or one you visit often) rather than a page from your history.
      icon = suggestion.completion || suggestion.group ? <IconGlobe size={16} /> : <IconClock size={16} />
      title = suggestion.title
      detail = hostOf(suggestion.url)
      break
    case 'url':
      icon = <IconGlobe size={16} />
      title = suggestion.url
      chip = 'Open'
      break
    case 'site':
      // A globe, not the site's icon: fetching that would tell the site what you're typing.
      icon = <IconGlobe size={16} />
      title = suggestion.title
      detail = suggestion.domain
      break
    case 'search':
      icon = <IconSearch size={16} />
      title = suggestion.query
      detail = suggestion.fromProvider ? null : `Search with ${engineName}`
      break
    case 'bang':
      icon = suggestion.domain ? <Favicon src={`https://${suggestion.domain}/favicon.ico`} size={16} /> : <IconSearch size={16} />
      if (suggestion.url) {
        title = suggestion.query || suggestion.name
        detail = suggestion.query ? `Search ${suggestion.name}` : suggestion.domain
        chip = `!${suggestion.trigger}`
      } else {
        title = `!${suggestion.trigger}`
        detail = suggestion.name
        chip = 'Bang'
      }
      break
  }

  // Pages from your history can be taken out of it (not sites you visit often, which stand for many).
  const removable = suggestion.kind === 'history' && !suggestion.group

  return (
    <div
      className={cx('suggestion', selected && 'selected', hovered && !selected && 'hovered')}
      data-selected={selected}
      onMouseMove={onHover}
      // The field keeps the focus; a click opens the row when the button comes up, as in Chrome.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => onChoose(e.metaKey ? 'background' : e.shiftKey ? 'window' : undefined)}
      onAuxClick={(e) => e.button === 1 && onChoose('background')}
    >
      <span className="suggestion-icon">{icon}</span>
      <span className="suggestion-title">{title}</span>
      {detail && <span className="suggestion-detail">— {detail}</span>}
      {chip && (
        <span className="suggestion-chip">
          {chip} <IconArrowRight size={12} />
        </span>
      )}
      {removable && (selected || hovered) && (
        <button
          className="suggestion-remove"
          title="Remove from history (⇧Delete)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          <IconClose size={11} />
        </button>
      )}
    </div>
  )
}
