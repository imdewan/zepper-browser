import type { Suggestion, Tab } from '@shared/types'
import type { History } from './history'
import { bangs } from './bangs'
import { looksLikeUrl, resolveInput, searchUrl, suggestUrl } from './url'

const PROVIDER_TIMEOUT_MS = 700

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
    if (Array.isArray(data)) return data.map((d) => (typeof d === 'string' ? d : (d as { phrase?: string }).phrase ?? '')).filter(Boolean)
    return []
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Builds URL bar results: the direct action first (go to URL or search),
 * then open tabs, history, and search-engine suggestions.
 */
export async function suggest(
  text: string,
  tabs: Tab[],
  history: History,
  useProvider = true,
  skipHistory = false
): Promise<Suggestion[]> {
  const query = text.trim()
  if (!query) {
    return tabs
      .filter((t) => t.loaded)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, 6)
      .map((t) => ({ kind: 'tab', tabId: t.id, url: t.url, title: t.title, favicon: t.favicon }))
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

  if (looksLikeUrl(query)) {
    const url = resolveInput(query)
    results.push({ kind: 'url', url, title: url })
  } else {
    results.push({ kind: 'search', query, url: searchUrl(query), fromProvider: false })
  }

  const lower = query.toLowerCase()
  const tabMatches = tabs
    .filter((t) => `${t.title} ${t.url}`.toLowerCase().includes(lower))
    .slice(0, 3)
  for (const t of tabMatches) {
    results.push({ kind: 'tab', tabId: t.id, url: t.url, title: t.title, favicon: t.favicon })
  }

  const openUrls = new Set(tabs.map((t) => t.url))
  for (const visit of skipHistory ? [] : history.search(query, 6)) {
    if (openUrls.has(visit.url)) continue
    results.push({ kind: 'history', url: visit.url, title: visit.title || visit.url })
    if (results.length >= 7) break
  }

  const provider = useProvider ? await fetchSearchSuggestions(query) : []
  for (const phrase of provider) {
    if (phrase.toLowerCase() === lower) continue
    results.push({ kind: 'search', query: phrase, url: searchUrl(phrase), fromProvider: true })
    if (results.length >= 11) break
  }
  return results
}
