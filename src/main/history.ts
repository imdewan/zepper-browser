import { JsonFile } from './persist'

export interface Visit {
  url: string
  title: string
  visits: number
  lastVisit: number
}

interface EntryIndex {
  title: string
  haystack: string
  bare: string
  page: { protocol: string; host: string; pathname: string; search: string } | null
  host: string
  path: string
}

const MAX_ENTRIES = 10_000
/** How long after a visit the page's title is still recorded. */
const TITLE_SETTLE_MS = 60_000

/** Browsing history used for URL bar suggestions. */
export class History {
  private readonly file = new JsonFile<Visit[]>('history.json', 3000)
  private readonly entries = new Map<string, Visit>()
  private readonly forgetListeners = new Set<(urls: string[]) => void>()
  private readonly index = new WeakMap<Visit, EntryIndex>()

  constructor() {
    for (const visit of this.file.read() ?? []) this.entries.set(visit.url, visit)
  }

  record(url: string, title: string): void {
    if (!/^https?:/.test(url)) return
    const existing = this.entries.get(url)
    if (existing) {
      existing.visits += 1
      existing.lastVisit = Date.now()
      if (title) existing.title = title
    } else {
      this.entries.set(url, { url, title, visits: 1, lastVisit: Date.now() })
    }
    this.save()
  }

  /** Pages brought in from another browser: merged with what's here (more visits and later dates win). */
  importVisits(visits: { url: string; title: string; visits: number; lastVisit: number }[]): { added: number; updated: number } {
    let added = 0
    let updated = 0
    const now = Date.now()
    for (const visit of visits) {
      if (!/^https?:/.test(visit.url) || visit.url.length > 4096) continue
      const lastVisit = Math.min(now, Math.max(0, visit.lastVisit || 0))
      const existing = this.entries.get(visit.url)
      if (existing) {
        existing.visits = Math.max(existing.visits, visit.visits)
        if (lastVisit > existing.lastVisit) existing.lastVisit = lastVisit
        if (!existing.title && visit.title) existing.title = visit.title
        updated++
      } else {
        this.entries.set(visit.url, { url: visit.url, title: visit.title, visits: Math.max(1, visit.visits), lastVisit })
        added++
      }
    }
    this.save()
    return { added, updated }
  }

  /**
   * A page's title settled after the visit. Only shortly after it: a background tab ticking its title
   * (an unread count, a timer) would otherwise rewrite history every few seconds, forever.
   */
  updateTitle(url: string, title: string): void {
    const existing = this.entries.get(url)
    if (existing && title && existing.title !== title && (!existing.title || Date.now() - existing.lastVisit < TITLE_SETTLE_MS)) {
      existing.title = title
      this.save()
    }
  }

  /**
   * The site you most likely mean by the start of an address ("you" → youtube.com), for completing
   * it as you type: sites are scored by how often and how recently you visited any of their pages.
   */
  topHit(text: string): { url: string; title: string; completion: string } | null {
    const typed = text.trim().toLowerCase()
    const query = typed.replace(/^https?:\/\//, '').replace(/^www\./, '')
    if (!query || /\s/.test(query)) return null
    const now = Date.now()
    const candidates = new Map<string, { url: string; title: string; visits: number; lastVisit: number; root: boolean }>()
    for (const visit of this.entries.values()) {
      const index = this.indexOf(visit)
      if (!index.page) continue
      const page = index.page
      const { host, path } = index
      // A beginning of a host completes to the site; with a slash, to the page.
      const completion = !query.includes('/') && host.startsWith(query) ? host : path.toLowerCase().startsWith(query) ? path : null
      if (!completion) continue
      const root = page.pathname === '/' && !page.search
      const target = completion === host ? `${page.protocol}//${page.host}/` : visit.url
      const entry = candidates.get(completion)
      if (entry) {
        entry.visits += visit.visits
        entry.lastVisit = Math.max(entry.lastVisit, visit.lastVisit)
        if (root && !entry.root) Object.assign(entry, { title: visit.title, root })
      } else {
        candidates.set(completion, {
          url: target,
          title: root || completion !== host ? visit.title : host,
          visits: visit.visits,
          lastVisit: visit.lastVisit,
          root
        })
      }
    }
    let best: { completion: string; url: string; title: string; score: number } | null = null
    for (const [completion, entry] of candidates) {
      const ageDays = (now - entry.lastVisit) / 86_400_000
      // Shorter completions win ties: the site before one of its pages.
      const score = Math.log2(1 + entry.visits) * 10 - Math.min(ageDays, 90) * 0.3 - completion.length * 0.05
      if (!best || score > best.score) best = { completion, url: entry.url, title: entry.title || completion, score }
    }
    // A single old visit isn't enough to take over what you type.
    if (!best || (best.score < 4 && query.length < 3)) return null
    const prefix = typed.startsWith('www.') ? 'www.' : ''
    return { url: best.url, title: best.title, completion: prefix + best.completion }
  }

  /** The sites you visit most (one page per site, its most visited), by frequency and recency. */
  frequent(limit: number, skipHosts: Set<string> = new Set()): Visit[] {
    const now = Date.now()
    const sites = new Map<string, { best: Visit; score: number }>()
    for (const visit of this.entries.values()) {
      let host: string
      try {
        host = new URL(visit.url).hostname.replace(/^www\./, '')
      } catch {
        continue
      }
      if (skipHosts.has(host)) continue
      const ageDays = (now - visit.lastVisit) / 86_400_000
      const score = Math.log2(1 + visit.visits) * 10 - Math.min(ageDays, 60) * 0.5
      const site = sites.get(host)
      if (!site) sites.set(host, { best: visit, score })
      else {
        site.score += score * 0.5
        if (visit.visits > site.best.visits) site.best = visit
      }
    }
    return [...sites.values()]
      .filter((site) => site.best.visits >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((site) => site.best)
  }

  /** Each entry's search text and parsed address, worked out once (searching runs on every keystroke). */
  private indexOf(visit: Visit): EntryIndex {
    const cached = this.index.get(visit)
    if (cached && cached.title === visit.title) return cached
    let page: EntryIndex['page'] = null
    let host = ''
    let path = ''
    try {
      const url = new URL(visit.url)
      page = { protocol: url.protocol, host: url.host, pathname: url.pathname, search: url.search }
      host = url.host.replace(/^www\./, '')
      path = `${host}${url.pathname.replace(/\/$/, '')}${url.search}`
    } catch {
      // Not a URL Zepper can complete to.
    }
    const entry: EntryIndex = {
      title: visit.title,
      haystack: `${visit.url} ${visit.title}`.toLowerCase(),
      bare: visit.url.replace(/^https?:\/\/(www\.)?/, '').toLowerCase(),
      page,
      host,
      path
    }
    this.index.set(visit, entry)
    return entry
  }

  /** Ranks entries matching every token, favouring host prefixes, frequency and recency. */
  search(text: string, limit: number): Visit[] {
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return []
    const now = Date.now()
    const scored: { visit: Visit; score: number }[] = []
    for (const visit of this.entries.values()) {
      const { haystack, bare } = this.indexOf(visit)
      if (!tokens.every((t) => haystack.includes(t))) continue
      const ageDays = (now - visit.lastVisit) / 86_400_000
      let score = Math.log2(1 + visit.visits) * 10 - Math.min(ageDays, 90) * 0.3
      if (bare.startsWith(tokens[0])) score += 40
      if (bare.split('/').length <= 2) score += 8
      scored.push({ visit, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((s) => s.visit)
  }

  /** For the history page: newest first, optionally filtered by every word of a query. */
  list(query: string, limit: number): Visit[] {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    const matches = [...this.entries.values()].filter(
      (v) => tokens.length === 0 || tokens.every((t) => `${v.url} ${v.title}`.toLowerCase().includes(t))
    )
    return matches.sort((a, b) => b.lastVisit - a.lastVisit).slice(0, limit)
  }

  has(url: string): boolean {
    return this.entries.has(url)
  }

  get(url: string): Visit | undefined {
    return this.entries.get(url)
  }

  /** Called with the URLs history forgets (so what's derived from them can go too). */
  onForget(listener: (urls: string[]) => void): void {
    this.forgetListeners.add(listener)
  }

  remove(url: string): void {
    if (this.entries.delete(url)) this.save()
    for (const listener of this.forgetListeners) listener([url])
  }

  /** Forgets everything visited since a time (0: all history). */
  clearSince(since: number): void {
    const gone: string[] = []
    for (const [url, visit] of this.entries) {
      if (visit.lastVisit < since) continue
      this.entries.delete(url)
      gone.push(url)
    }
    this.save()
    for (const listener of this.forgetListeners) listener(gone)
  }

  flush(): void {
    this.file.flush()
  }

  private save(): void {
    // Over the limit: back down to 90% of it, so the trim (a sort) doesn't run on every visit.
    if (this.entries.size > MAX_ENTRIES) {
      const sorted = [...this.entries.values()].sort((a, b) => b.lastVisit - a.lastVisit)
      this.entries.clear()
      for (const v of sorted.slice(0, Math.floor(MAX_ENTRIES * 0.9))) this.entries.set(v.url, v)
    }
    this.file.schedule([...this.entries.values()])
  }
}
