import type { Suggestion, Tab } from '@shared/types'
import type { History } from './history'
import { bangs } from './bangs'
import { popularByAddress, popularMatches } from './popular-sites'
import { hostOf, looksLikeUrl, resolveInput, searchUrl, stripHash, suggestUrl } from './url'

/** The search engine gets this long; its suggestions hold nothing up, so a slow answer is still worth waiting for. */
const PROVIDER_TIMEOUT_MS = 1500

/** Fetches OpenSearch-style suggestions (`[query, [phrases…]]`) from the chosen engine. */
async function fetchSearchSuggestions(text: string): Promise<string[]> {
  const url = suggestUrl(text)
  if (!url) return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    const data = (await res.json()) as unknown
    if (Array.isArray(data) && Array.isArray(data[1])) return (data[1] as unknown[]).map(String)
    if (Array.isArray(data)) return data.map((d) => (typeof d === 'string' ? d : ((d as { phrase?: string }).phrase ?? ''))).filter(Boolean)
    return []
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Builds URL bar results: the direct action first (go to URL or search), then open tabs, history
 * and popular sites. All of it is on this Mac, so it's instant; the search engine's suggestions
 * come separately (searchSuggestions), added below once they arrive.
 */
export function suggest(text: string, tabs: Tab[], history: History, skipHistory = false, recents = true): Suggestion[] {
  const query = text.trim()
  if (!query) {
    // Nothing typed: your recent tabs, then the sites you visit most.
    const recent: Suggestion[] = tabs
      .filter((t) => t.loaded)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, 4)
      .map((t) => ({ kind: 'tab', tabId: t.id, url: t.url, title: t.title, favicon: t.favicon, group: 'recent' }))
    if (skipHistory || !recents) return recent
    const openHosts = new Set(tabs.map((t) => hostOf(t.url)))
    for (const visit of history.frequent(10 - recent.length, openHosts)) {
      recent.push({ kind: 'history', url: visit.url, title: visit.title || visit.url, group: 'frequent' })
    }
    return recent
  }

  const results: Suggestion[] = []
  const bang = bangs.resolve(query)
  const completions = bangs.complete(query)
  if (bang) {
    const { t, s, d } = bang.bang
    results.push({ kind: 'bang', trigger: t, name: s, domain: d, query: bang.query, url: bang.url })
  }
  // Typing a bang: offer to complete it (choosing one fills it in instead of navigating).
  for (const b of completions) {
    if (bang && b.t === bang.bang.t) continue
    results.push({ kind: 'bang', trigger: b.t, name: b.s, domain: b.d, query: '', url: null })
  }
  if (bang || completions.length > 0) return results

  // The site you're typing the address of comes first, completed in the field (Return goes there).
  // From your history; failing that, the most popular site with that address ("yout" → youtube.com).
  const visited = skipHistory ? null : history.topHit(query)
  const popular = visited ? undefined : popularByAddress(query)
  const top = visited ?? (popular ? { url: `https://${popular.domain}/`, title: popular.name, completion: popular.domain } : null)
  // Already open: the top hit switches to that tab instead.
  const topTab = top ? tabs.find((t) => stripHash(t.url) === stripHash(top.url)) : undefined
  if (top && topTab) {
    results.push({
      kind: 'tab',
      tabId: topTab.id,
      url: topTab.url,
      title: topTab.title,
      favicon: topTab.favicon,
      completion: top.completion
    })
  } else if (popular && top) {
    results.push({ kind: 'site', url: top.url, title: top.title, domain: popular.domain, completion: top.completion })
  } else if (top) {
    results.push({ kind: 'history', url: top.url, title: top.title, completion: top.completion })
  }
  if (looksLikeUrl(query)) {
    const url = resolveInput(query)
    if (!top || hostOf(url) !== hostOf(top.url)) results.push({ kind: 'url', url, title: url })
  } else {
    results.push({ kind: 'search', query, url: searchUrl(query), fromProvider: false })
  }

  const lower = query.toLowerCase()
  const tabMatches = tabs.filter((t) => t !== topTab && `${t.title} ${t.url}`.toLowerCase().includes(lower)).slice(0, 3)
  for (const t of tabMatches) {
    results.push({ kind: 'tab', tabId: t.id, url: t.url, title: t.title, favicon: t.favicon })
  }

  const openUrls = new Set(tabs.map((t) => t.url))
  // Pages that would look the same (same title on the same site, like several "YouTube" pages) show once.
  const looks = (title: string, url: string): string => `${title.toLowerCase()}|${hostOf(url)}`
  const seen = new Set(results.flatMap((r) => ('url' in r && r.url && 'title' in r ? [looks(r.title, r.url)] : [])))
  for (const visit of skipHistory ? [] : history.search(query, 10)) {
    const title = visit.title || visit.url
    if (openUrls.has(visit.url) || visit.url === top?.url || seen.has(looks(title, visit.url))) continue
    seen.add(looks(title, visit.url))
    results.push({ kind: 'history', url: visit.url, title })
    if (results.length >= 7) break
  }

  // Popular sites matching the address or name ("gmail", "twitter"), unless they're already listed.
  const listed = new Set(results.flatMap((r) => ('url' in r && r.url ? [hostOf(r.url)] : [])))
  for (const tab of tabs) listed.add(hostOf(tab.url))
  let added = 0
  for (const site of popularMatches(query, 6)) {
    if (listed.has(site.domain) || added >= 3) continue
    results.push({ kind: 'site', url: `https://${site.domain}/`, title: site.name, domain: site.domain })
    added++
  }

  return results
}

/** The search engine's suggestions for what's typed (none for a bang, which goes to its own site). */
export async function searchSuggestions(text: string): Promise<Suggestion[]> {
  const query = text.trim()
  if (!query || bangs.resolve(query) || bangs.complete(query).length > 0) return []
  const lower = query.toLowerCase()
  return (await fetchSearchSuggestions(query))
    .filter((phrase) => phrase.toLowerCase() !== lower)
    .map((phrase) => ({ kind: 'search', query: phrase, url: searchUrl(phrase), fromProvider: true }))
}
