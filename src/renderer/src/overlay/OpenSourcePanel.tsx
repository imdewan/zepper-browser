import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { zepper } from '../bridge'
import { IconBack, IconChevronDown, IconChevronRight, IconClose } from '../icons'
import { cx } from '../util'

/** What scripts/licenses.mjs writes: license texts are stored once and referred to by index. */
interface OpenSourceData {
  zepper: { license: string; text: number }
  projects: Project[]
  packages: Project[]
  texts: string[]
}

interface Project {
  name: string
  version?: string
  license: string
  author?: string
  url?: string
  /** What it does in Zepper, for what isn't a package. */
  detail?: string
  group?: string
  text?: number
  notice?: number
  /** The package doesn't come with its license's text: `text` is that license's standard one. */
  standard?: boolean
  /** Chromium: its own credits, every component with its license, open in a tab. */
  chromiumCredits?: boolean
}

const SOURCE = 'https://github.com/imdewan/zepper-browser'

/**
 * About › Open Source: Zepper is open source itself, and here is everything it's built on,
 * each with its license in full (whatever the license asks for, MIT's included). The list loads when
 * this opens: it's the one part of About with any size.
 */
export function OpenSourcePanel({ onBack, onClose }: { onBack: () => void; onClose: () => void }): React.JSX.Element {
  const [data, setData] = useState<OpenSourceData | null>(null)
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [scrolled, setScrolled] = useState(false)
  const search = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void import('./open-source.generated.json').then((module) => setData(module.default as OpenSourceData))
    search.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onBack()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onBack])

  const groups = useMemo(() => {
    if (!data) return []
    const needle = filter.trim().toLowerCase()
    const matches = (p: Project): boolean =>
      !needle || [p.name, p.license, p.author ?? '', p.detail ?? ''].some((field) => field.toLowerCase().includes(needle))
    const byGroup = new Map<string, Project[]>()
    for (const project of data.projects)
      if (matches(project)) byGroup.set(project.group!, [...(byGroup.get(project.group!) ?? []), project])
    const packages = data.packages.filter(matches)
    if (packages.length) byGroup.set('Packages', packages)
    return [...byGroup]
  }, [data, filter])

  const visit = (url: string): void => {
    zepper.send({ type: 'tab.open', input: url, where: 'new' })
    onClose()
  }

  const total = data ? data.projects.length + data.packages.length : 0

  return (
    <motion.div
      className="settings open-source"
      initial={{ opacity: 0, scale: 0.97, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.15 } }}
      transition={{ type: 'spring', bounce: 0.15, duration: 0.4 }}
    >
      <div className="settings-main">
        <header className={cx('settings-bar sub', scrolled && 'scrolled')}>
          <button className="settings-back" title="Back to About (Esc)" onClick={onBack}>
            <IconBack size={15} />
          </button>
          <h2>Open Source</h2>
          <button className="settings-close" title="Close" onClick={onClose}>
            <IconClose size={14} />
          </button>
        </header>
        <div className="settings-body" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
          <section className="open-source-intro">
            <p>
              Zepper is free and open-source software, under the GNU General Public License, version&nbsp;3: anyone can read its code,
              change it and share it, under the same terms.
            </p>
            <p>
              It’s built on the work of many other open-source projects, and respects every one of their licenses: each is listed here with
              its license in full. Thank you to everyone who makes them.
            </p>
            <div className="open-source-actions">
              <button className="panel-button primary" onClick={() => visit(SOURCE)}>
                Zepper’s Code
              </button>
              <button className="panel-button" onClick={() => setOpen(open === 'zepper' ? null : 'zepper')}>
                {open === 'zepper' ? 'Hide' : 'Zepper’s'} License
              </button>
            </div>
            {open === 'zepper' && data && <pre className="open-source-text">{data.texts[data.zepper.text]}</pre>}
          </section>

          <input
            ref={search}
            className="settings-input open-source-search"
            placeholder={total ? `Search ${total} projects` : 'Search'}
            value={filter}
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
          />

          {groups.map(([group, projects]) => (
            <section key={group}>
              <h3 className="shortcut-group-title">
                {group}
                {group === 'Packages' && <span className="open-source-count"> · {projects.length}</span>}
              </h3>
              {projects.map((project) => {
                const key = `${group}:${project.name}@${project.version ?? ''}`
                const expanded = open === key
                return (
                  <div key={key} className={cx('open-source-item', expanded && 'expanded')}>
                    <button className="open-source-row" onClick={() => setOpen(expanded ? null : key)}>
                      <span className="open-source-chevron">
                        {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                      </span>
                      <span className="settings-row-text">
                        <span className="settings-row-label">
                          {project.name}
                          {project.version && <span className="open-source-version"> {project.version}</span>}
                        </span>
                        {(project.author || project.detail) && (
                          <span className="settings-row-hint open-source-hint">{project.detail ?? project.author}</span>
                        )}
                      </span>
                      <span className="open-source-license">{project.license}</span>
                    </button>
                    {expanded && data && (
                      <div className="open-source-details">
                        {project.detail && project.author && <div className="open-source-by">By {project.author}</div>}
                        <div className="open-source-links">
                          {project.chromiumCredits && (
                            <button
                              className="panel-button"
                              onClick={() => {
                                zepper.send({ type: 'app.openChromiumCredits' })
                                onClose()
                              }}
                            >
                              Chromium’s Credits
                            </button>
                          )}
                          {project.url && (
                            <button className="panel-button" onClick={() => visit(project.url!)}>
                              {project.chromiumCredits ? 'Website' : 'Project Page'}
                            </button>
                          )}
                        </div>
                        {project.standard && (
                          <p className="open-source-note">
                            It doesn’t come with its license’s text, so here is the standard text of the {project.license} license.
                          </p>
                        )}
                        {project.text !== undefined && <pre className="open-source-text">{data.texts[project.text]}</pre>}
                        {project.notice !== undefined && <pre className="open-source-text">{data.texts[project.notice]}</pre>}
                        {project.text === undefined && !project.chromiumCredits && (
                          <p className="open-source-note">Its license is on its project page.</p>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </section>
          ))}
          {data && groups.length === 0 && <p className="shortcuts-note">Nothing matches.</p>}
        </div>
      </div>
    </motion.div>
  )
}
