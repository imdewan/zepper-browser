import { useState } from 'react'
import { IconSearch } from '../icons'

/** Chips shown before "Show all", and how many sites it takes to get a search field. */
const COLLAPSED_COUNT = 6
const SEARCH_FROM = 11

const bare = (site: string): string => site.replace(/^www\./, '').toLowerCase()

/**
 * A settings list of sites (permissions, protections, passwords never saved) that stays short as it
 * grows: sites in A–Z order, the first few with "Show all", and a search field once there are many.
 */
export function SiteChips<T>({
  items,
  site,
  chip
}: {
  items: T[]
  /** The site an item is for, to sort and search by. */
  site: (item: T) => string
  chip: (item: T) => React.JSX.Element
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const sorted = [...items].sort((a, b) => bare(site(a)).localeCompare(bare(site(b))))
  const q = query.trim().toLowerCase()
  const matching = q ? sorted.filter((item) => site(item).toLowerCase().includes(q)) : sorted
  const shown = expanded || q ? matching : matching.slice(0, COLLAPSED_COUNT)
  return (
    <div className="site-chip-list">
      {items.length >= SEARCH_FROM && (
        <label className="pw-search site-chip-search">
          <IconSearch size={13} />
          <input value={query} placeholder={`Search ${items.length} sites`} spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        </label>
      )}
      {matching.length > 0 ? (
        <div className="site-chips">
          {shown.map(chip)}
          {!q && matching.length > COLLAPSED_COUNT && (
            <button className="site-chip site-chip-more" onClick={() => setExpanded((open) => !open)}>
              {expanded ? 'Show fewer' : `Show all ${matching.length}`}
            </button>
          )}
        </div>
      ) : (
        <p className="site-chip-empty">No sites match.</p>
      )}
    </div>
  )
}
