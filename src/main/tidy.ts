import { parse } from 'tldts-experimental'
import { intelligence } from './ai'

/**
 * Tidy Tabs: groups related tabs into named folders. With Apple Intelligence it asks the
 * on-device model (see ai.ts); anywhere else it groups tabs from the same site.
 */

export interface TidyTab {
  title: string
  url: string
}

export interface TidyGroup {
  name: string
  /** Indexes into the tabs passed in. */
  tabs: number[]
}

export type TidyMode = { kind: 'ai' } | { kind: 'site'; reason: string }

/** Whether Apple Intelligence can tidy here. */
export async function tidyMode(): Promise<TidyMode> {
  const status = await intelligence.status()
  return status.ai ? { kind: 'ai' } : { kind: 'site', reason: status.reason ?? 'Apple Intelligence isn’t available.' }
}

/** Groups of related tabs (each at least two); tabs that fit nowhere are left out. */
export async function tidyGroups(tabs: TidyTab[], useAi = true): Promise<TidyGroup[]> {
  if (useAi && (await tidyMode()).kind === 'ai') {
    try {
      const { groups } = await intelligence.request<{ groups: TidyGroup[] }>('tidy', {
        tabs: tabs.map((t) => ({ title: t.title, host: hostOf(t.url) }))
      })
      return clean(groups, tabs.length)
    } catch (error) {
      console.warn('[tidy] Apple Intelligence failed, grouping by site', error)
    }
  }
  return bySite(tabs)
}

/** Each tab in at most one group, groups of two or more. */
function clean(groups: TidyGroup[], count: number): TidyGroup[] {
  const used = new Set<number>()
  return groups
    .map((g) => ({
      name: g.name.trim().slice(0, 40) || 'Group',
      tabs: g.tabs.filter((i) => i >= 0 && i < count && !used.has(i) && used.add(i))
    }))
    .filter((g) => g.tabs.length >= 2)
}

/** Without Apple Intelligence: tabs from the same site go together. */
function bySite(tabs: TidyTab[]): TidyGroup[] {
  const sites = new Map<string, number[]>()
  tabs.forEach((tab, i) => {
    const site = parse(tab.url).domain
    if (site) sites.set(site, [...(sites.get(site) ?? []), i])
  })
  return [...sites.entries()]
    .filter(([, indexes]) => indexes.length >= 2)
    .map(([site, indexes]) => ({ name: siteName(site), tabs: indexes }))
}

function siteName(domain: string): string {
  const name = domain.split('.')[0]
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
