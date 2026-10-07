import { useState } from 'react'
import { IconChevronRight, IconSearch } from '../icons'

/** One site on a list page: what's set for it, and the button that undoes it. */
export interface SiteListItem {
  key: string
  site: string
  detail?: string
}

const bare = (site: string): string => site.replace(/^www\./, '').toLowerCase()

/**
 * A settings page listing sites (permissions, protections, passwords never saved), searchable and in
 * A–Z order, each with a button that undoes what's set for it. Opened from a SiteListLink.
 */
export function SiteListPage({
  items,
  action,
  actionTitle,
  empty,
  onAction
}: {
  items: SiteListItem[]
  /** The button on each row ("Reset", "Turn on"…). */
  action: string
  actionTitle: (item: SiteListItem) => string
  empty: string
  onAction: (item: SiteListItem) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const sorted = [...items].sort((a, b) => bare(a.site).localeCompare(bare(b.site)))
  const shown = q ? sorted.filter((item) => item.site.toLowerCase().includes(q)) : sorted
  return (
    <>
      <div className="pw-toolbar">
        <label className="pw-search">
          <IconSearch size={13} />
          <input
            autoFocus
            value={query}
            placeholder={items.length ? `Search ${items.length === 1 ? '1 site' : `${items.length} sites`}` : 'Search sites'}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="pw-list">
        {items.length === 0 && <p className="pw-empty">{empty}</p>}
        {items.length > 0 && shown.length === 0 && <p className="pw-empty">No sites match.</p>}
        {shown.map((item) => (
          <div key={item.key} className="pw-row static">
            <SiteInitial site={item.site} />
            <span className="pw-row-text">
              <span className="pw-host">{item.site}</span>
              {item.detail && <span className="pw-user">{item.detail}</span>}
            </span>
            <button className="panel-button" title={actionTitle(item)} onClick={() => onAction(item)}>
              {action}
            </button>
          </div>
        ))}
      </div>
    </>
  )
}

/** The row in a settings section that opens a site list page: how many sites, and a way in. */
export function SiteListLink({
  label,
  hint,
  count,
  onOpen
}: {
  label: string
  hint: string
  count: number
  onOpen: () => void
}): React.JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        <div className="settings-row-hint">{hint}</div>
      </div>
      <div className="settings-row-control">
        <button className="panel-button site-list-open" onClick={onOpen}>
          {count === 0 ? 'None' : count === 1 ? '1 site' : `${count} sites`}
          <IconChevronRight size={12} />
        </button>
      </div>
    </div>
  )
}

/** The site's first letter on a steady colour, as in Passwords. */
function SiteInitial({ site }: { site: string }): React.JSX.Element {
  const name = bare(site)
  let hash = 0
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) | 0
  return (
    <span className="pw-avatar" style={{ background: `hsl(${Math.abs(hash) % 360} 45% 52%)` }}>
      {name[0]?.toUpperCase() ?? '?'}
    </span>
  )
}
