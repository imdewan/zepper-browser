import { app } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import bundled from './bangs-top.json'

/**
 * DuckDuckGo bangs, resolved locally (like Theo's unduck): `!yt cats` goes
 * straight to YouTube's search instead of through duckduckgo.com. The 500
 * most used bangs ship with the app so they work instantly; the full list
 * (~13,500) is downloaded in the background, cached and refreshed weekly.
 */

export interface Bang {
  /** Trigger, without the `!`. */
  t: string
  /** Site name. */
  s: string
  /** Domain, where an empty query goes. */
  d: string
  /** URL template with {{{s}}} for the query. */
  u: string
  /** Relevance (DuckDuckGo's usage ranking). */
  r: number
}

const SOURCE = 'https://duckduckgo.com/bang.js'
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000
/** `!yt`, at the start or after a space, as DuckDuckGo reads it: `!yt cats` or `cats !yt`. */
const BANG = /(?:^|\s)!(\S+)/
/** A bang still being typed at the end of the input: `!yo`. */
const PARTIAL = /(?:^|\s)!(\S*)$/

export interface ResolvedBang {
  bang: Bang
  /** The query without the bang. */
  query: string
  url: string
}

class Bangs {
  private byTrigger = new Map<string, Bang>()
  /** Most used first, for completions. */
  private ranked: Bang[] = []

  constructor() {
    this.use(bundled as Bang[])
  }

  /** Loads the cached full list, and refreshes it from DuckDuckGo when it's missing or a week old. */
  async load(): Promise<void> {
    const cache = join(app.getPath('userData'), 'bangs.json')
    try {
      const list = JSON.parse(await readFile(cache, 'utf8')) as Bang[]
      if (Array.isArray(list) && list.length > 1000) this.use(list)
      if (Date.now() - (await stat(cache)).mtimeMs < REFRESH_MS) return
    } catch {
      // No cache yet.
    }
    try {
      const raw = (await (await fetch(SOURCE)).json()) as Partial<Bang>[]
      const list = raw
        .filter((b): b is Bang => typeof b.t === 'string' && typeof b.u === 'string' && b.u.includes('{{{s}}}'))
        .map(({ t, s, d, u, r }) => ({ t, s: s ?? t, d: d ?? '', u, r: r ?? 0 }))
      if (list.length < 1000) return
      this.use(list)
      await writeFile(cache, JSON.stringify(list))
    } catch (error) {
      console.warn('[bangs] update failed', error)
    }
  }

  /** Where a query with a known bang goes; null when it has none. */
  resolve(input: string): ResolvedBang | null {
    const match = BANG.exec(input)
    const bang = match && this.byTrigger.get(match[1].toLowerCase())
    if (!match || !bang) return null
    const query = `${input.slice(0, match.index)} ${input.slice(match.index + match[0].length)}`.trim()
    const template = bang.u.startsWith('/') ? `https://duckduckgo.com${bang.u}` : bang.u
    // An empty query (just `!gh`) goes to the site itself; `/` stays readable in paths (`!ghr owner/repo`).
    const url = query ? template.replace('{{{s}}}', encodeURIComponent(query).replace(/%2F/g, '/')) : homeOf(bang, template)
    return { bang, query, url }
  }

  /** Bangs matching the one being typed at the end of the input, most used first. */
  complete(input: string, limit = 4): Bang[] {
    const match = PARTIAL.exec(input)
    if (!match) return []
    const prefix = match[1].toLowerCase()
    const exact = this.byTrigger.get(prefix)
    const results = exact ? [exact] : []
    for (const bang of this.ranked) {
      if (results.length >= limit) break
      if (bang !== exact && bang.t.toLowerCase().startsWith(prefix)) results.push(bang)
    }
    return results
  }

  private use(list: Bang[]): void {
    this.byTrigger = new Map(list.map((b) => [b.t.toLowerCase(), b]))
    this.ranked = [...list].sort((a, b) => b.r - a.r)
  }
}

function homeOf(bang: Bang, template: string): string {
  if (bang.d) return `https://${bang.d}`
  try {
    return new URL(template.replace('{{{s}}}', '')).origin
  } catch {
    return template.replace('{{{s}}}', '')
  }
}

export const bangs = new Bangs()
