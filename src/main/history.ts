import { JsonFile } from './persist'

export interface Visit {
  url: string
  title: string
  visits: number
  lastVisit: number
}

const MAX_ENTRIES = 10_000

/** Browsing history used for URL bar suggestions. */
export class History {
  private readonly file = new JsonFile<Visit[]>('history.json', 3000)
  private readonly entries = new Map<string, Visit>()

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

  updateTitle(url: string, title: string): void {
    const existing = this.entries.get(url)
    if (existing && title && existing.title !== title) {
      existing.title = title
      this.save()
    }
  }

  /** Ranks entries matching every token, favouring host prefixes, frequency and recency. */
  search(text: string, limit: number): Visit[] {
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return []
    const now = Date.now()
    const scored: { visit: Visit; score: number }[] = []
    for (const visit of this.entries.values()) {
      const haystack = `${visit.url} ${visit.title}`.toLowerCase()
      if (!tokens.every((t) => haystack.includes(t))) continue
      const bare = visit.url.replace(/^https?:\/\/(www\.)?/, '').toLowerCase()
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

  remove(url: string): void {
    if (this.entries.delete(url)) this.save()
  }

  /** Forgets everything visited since a time (0: all history). */
  clearSince(since: number): void {
    for (const [url, visit] of this.entries) if (visit.lastVisit >= since) this.entries.delete(url)
    this.save()
  }

  flush(): void {
    this.file.flush()
  }

  private save(): void {
    if (this.entries.size > MAX_ENTRIES) {
      const sorted = [...this.entries.values()].sort((a, b) => b.lastVisit - a.lastVisit)
      this.entries.clear()
      for (const v of sorted.slice(0, MAX_ENTRIES)) this.entries.set(v.url, v)
    }
    this.file.schedule([...this.entries.values()])
  }
}
