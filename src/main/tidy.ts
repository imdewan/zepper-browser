import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'tldts-experimental'

/**
 * Tidy Tabs: groups related tabs into named folders. On Macs with Apple Intelligence it asks
 * the on-device model through a small Swift helper (native/tidy, built by `npm run build:native`);
 * anywhere else it groups tabs from the same site. Nothing leaves the Mac either way.
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

const TIMEOUT_MS = 30_000

function helperPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'bin', 'zepper-tidy') : join(app.getAppPath(), 'build', 'bin', 'zepper-tidy')
}

let mode: Promise<TidyMode> | null = null

/** Whether Apple Intelligence can tidy here (checked once). */
export function tidyMode(): Promise<TidyMode> {
  mode ??= new Promise((resolve) => {
    const helper = helperPath()
    if (process.platform !== 'darwin' || !existsSync(helper)) {
      return resolve({ kind: 'site', reason: 'Apple Intelligence tidying needs macOS 26 or later.' })
    }
    execFile(helper, ['--check'], { timeout: 10_000 }, (error, stdout) => {
      try {
        const result = JSON.parse(stdout) as { available: boolean; reason?: string }
        resolve(result.available ? { kind: 'ai' } : { kind: 'site', reason: result.reason ?? 'Apple Intelligence isn’t available.' })
      } catch {
        resolve({ kind: 'site', reason: error ? 'Apple Intelligence isn’t available on this Mac.' : 'Apple Intelligence isn’t available.' })
      }
    })
  })
  return mode
}

/** Groups of related tabs (each at least two); tabs that fit nowhere are left out. */
export async function tidyGroups(tabs: TidyTab[]): Promise<TidyGroup[]> {
  if ((await tidyMode()).kind === 'ai') {
    try {
      return clean(await askAppleIntelligence(tabs), tabs.length)
    } catch (error) {
      console.warn('[tidy] Apple Intelligence failed, grouping by site', error)
    }
  }
  return bySite(tabs)
}

function askAppleIntelligence(tabs: TidyTab[]): Promise<TidyGroup[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'ignore'] })
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const result = JSON.parse(out) as { groups?: TidyGroup[]; error?: string }
        if (result.groups) resolve(result.groups)
        else reject(new Error(result.error ?? 'no result'))
      } catch (error) {
        reject(error)
      }
    })
    child.stdin.end(JSON.stringify({ tabs: tabs.map((t) => ({ title: t.title, host: hostOf(t.url) })) }))
  })
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
