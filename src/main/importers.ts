import { app } from 'electron'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ImportKind, ImportSource } from '@shared/types'
import { readKeychain } from './native'
import type { ImportEntry } from './vault'
import { importTabs, type ImportedSession } from './session-import'

/**
 * Bringing your things into Zepper. Passwords: straight from Chromium-based browsers on this Mac
 * (their saved logins, decrypted with the key they keep in the Keychain, which macOS asks you to
 * allow), or from a CSV export: Apple Passwords and Safari, Firefox, Chrome, 1Password, Bitwarden,
 * LastPass, Proton Pass and others. History: from Chromium browsers, Firefox and Safari.
 *
 * On Linux: history and open tabs from the Chromium browsers and Firefox there (under ~/.config and
 * ~/.mozilla). Their passwords' key is in the desktop's keyring instead, so passwords come from a CSV.
 */

interface ChromiumBrowser {
  id: string
  name: string
  /** Under ~/Library/Application Support. */
  dir: string
  /** On Linux, under ~/.config (none: not on Linux). */
  linuxDir?: string
  /** The Keychain item holding its encryption key. */
  service: string
  account: string
}

const CHROMIUM_BROWSERS: ChromiumBrowser[] = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    dir: 'Google/Chrome',
    linuxDir: 'google-chrome',
    service: 'Chrome Safe Storage',
    account: 'Chrome'
  },
  {
    id: 'chrome-beta',
    name: 'Chrome Beta',
    dir: 'Google/Chrome Beta',
    linuxDir: 'google-chrome-beta',
    service: 'Chrome Safe Storage',
    account: 'Chrome'
  },
  {
    id: 'brave',
    name: 'Brave',
    dir: 'BraveSoftware/Brave-Browser',
    linuxDir: 'BraveSoftware/Brave-Browser',
    service: 'Brave Safe Storage',
    account: 'Brave'
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    dir: 'Microsoft Edge',
    linuxDir: 'microsoft-edge',
    service: 'Microsoft Edge Safe Storage',
    account: 'Microsoft Edge'
  },
  { id: 'arc', name: 'Arc', dir: 'Arc/User Data', service: 'Arc Safe Storage', account: 'Arc' },
  { id: 'vivaldi', name: 'Vivaldi', dir: 'Vivaldi', linuxDir: 'vivaldi', service: 'Vivaldi Safe Storage', account: 'Vivaldi' },
  { id: 'opera', name: 'Opera', dir: 'com.operasoftware.Opera', linuxDir: 'opera', service: 'Opera Safe Storage', account: 'Opera' },
  { id: 'helium', name: 'Helium', dir: 'net.imput.helium', service: 'Helium Storage Key', account: 'Helium' },
  { id: 'chromium', name: 'Chromium', dir: 'Chromium', linuxDir: 'chromium', service: 'Chromium Safe Storage', account: 'Chromium' }
]

const LINUX = process.platform === 'linux'
const supportDir = (): string =>
  LINUX ? process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config') : join(homedir(), 'Library', 'Application Support')
/** Where a browser keeps its profiles here (null: it isn't on this platform). */
const browserRoot = (browser: ChromiumBrowser): string | null => {
  const dir = LINUX ? browser.linuxDir : browser.dir
  return dir ? join(supportDir(), dir) : null
}

const blocked = (error: unknown): boolean => ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException)?.code ?? '')

/**
 * Profile folders holding saved logins ("Default", "Profile 1"…, or the browser folder itself, as
 * Opera does). macOS protects some browsers' data from other apps until you allow it: then all
 * that's known is that the browser is there.
 */
function profiles(browser: ChromiumBrowser): { dir: string; name: string }[] | 'blocked' {
  const root = browserRoot(browser)
  if (!root || !existsSync(root)) return []
  try {
    readdirSync(root)
  } catch (error) {
    return blocked(error) ? 'blocked' : []
  }
  let names: Record<string, { name?: string }> = {}
  try {
    const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8')) as { profile?: { info_cache?: typeof names } }
    names = state.profile?.info_cache ?? {}
  } catch {
    // No profile names; folder names will do.
  }
  const found: { dir: string; name: string }[] = []
  const hasData = (dir: string): boolean => existsSync(join(dir, 'Login Data')) || existsSync(join(dir, 'History'))
  if (hasData(root)) found.push({ dir: '.', name: 'Default' })
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(Default|Profile \d+)$/.test(entry.name)) continue
    if (hasData(join(root, entry.name))) found.push({ dir: entry.name, name: names[entry.name]?.name || entry.name })
  }
  return found
}

/** Firefox's profiles: on Linux, its own folder, or the Snap's or Flatpak's (as Ubuntu and Fedora install it). */
const FIREFOX_DIR = (): string =>
  LINUX
    ? ([
        join(homedir(), '.mozilla', 'firefox'),
        join(homedir(), 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
        join(homedir(), '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox')
      ].find((dir) => existsSync(join(dir, 'profiles.ini'))) ?? join(homedir(), '.mozilla', 'firefox'))
    : join(supportDir(), 'Firefox')
const SAFARI_HISTORY = (): string => join(homedir(), 'Library', 'Safari', 'History.db')

/** Firefox profiles with history (profiles.ini lists them). */
function firefoxProfiles(): { dir: string; name: string }[] | 'blocked' {
  const root = FIREFOX_DIR()
  if (!existsSync(root)) return []
  let ini: string
  try {
    ini = readFileSync(join(root, 'profiles.ini'), 'utf8')
  } catch (error) {
    return blocked(error) ? 'blocked' : []
  }
  const found: { dir: string; name: string }[] = []
  for (const section of ini.split(/^\[/m)) {
    if (!/^Profile\d+\]/.test(section)) continue
    const field = (key: string): string | undefined => new RegExp(`^${key}=(.*)$`, 'm').exec(section)?.[1]?.trim()
    const path = field('Path')
    if (!path) continue
    const dir = field('IsRelative') === '0' ? path : join(root, path)
    if (existsSync(join(dir, 'places.sqlite'))) found.push({ dir, name: field('Name') ?? 'Default' })
  }
  return found
}

/** Whether a file exists but macOS keeps it from Zepper (Safari's history, without Full Disk Access). */
function unreadable(path: string): boolean {
  try {
    closeSync(openSync(path, 'r'))
    return false
  } catch (error) {
    return blocked(error)
  }
}

/** Browsers on this Mac with history or passwords Zepper can import. */
export function importSources(): ImportSource[] {
  if (process.platform !== 'darwin' && !LINUX) return []
  const sources: ImportSource[] = CHROMIUM_BROWSERS.flatMap((browser) => {
    const found = profiles(browser)
    // On Linux their passwords' key is in the keyring, out of reach: passwords come from a CSV there.
    const kinds: ImportKind[] = LINUX ? ['history', 'tabs'] : ['history', 'passwords', 'tabs']
    if (found === 'blocked') return [{ id: browser.id, name: browser.name, profiles: [], kinds, blocked: true }]
    return found.length ? [{ id: browser.id, name: browser.name, profiles: found, kinds }] : []
  })
  const firefox = firefoxProfiles()
  if (firefox === 'blocked') sources.push({ id: 'firefox', name: 'Firefox', profiles: [], kinds: ['history', 'tabs'], blocked: true })
  else if (firefox.length) sources.push({ id: 'firefox', name: 'Firefox', profiles: firefox, kinds: ['history', 'tabs'] })
  if (!LINUX && existsSync(SAFARI_HISTORY())) {
    sources.push({
      id: 'safari',
      name: 'Safari',
      profiles: [{ dir: '.', name: 'Safari' }],
      kinds: ['history'],
      blocked: unreadable(SAFARI_HISTORY())
    })
  }
  return sources
}

export interface HistoryImport {
  url: string
  title: string
  visits: number
  lastVisit: number
}

/** A copy of a browser's SQLite database (with its write-ahead log), which may be open in that browser. */
function copyDatabase(path: string, name: string, temp: string): string {
  const copy = join(temp, name)
  copyFileSync(path, copy)
  for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) copyFileSync(path + suffix, copy + suffix)
  return copy
}

const HISTORY_LIMIT = 10_000

/** A browser's history: the most recent pages, with how often you visited them. */
export async function importHistory(sourceId: string, profileDir: string): Promise<HistoryImport[]> {
  const temp = mkdtempSync(join(app.getPath('temp'), 'zepper-import-'))
  const { DatabaseSync } = await import('node:sqlite')
  try {
    if (sourceId === 'safari') {
      if (unreadable(SAFARI_HISTORY())) throw new Error(blockedMessage('Safari'))
      const db = new DatabaseSync(copyDatabase(SAFARI_HISTORY(), 'History.db', temp), { readOnly: true })
      // Visits count seconds from 2001; each page's latest visit carries its title.
      const rows = db
        .prepare(
          `SELECT i.url AS url, i.visit_count AS visits, v.visit_time AS time, v.title AS title
           FROM history_items i JOIN history_visits v ON v.history_item = i.id
           WHERE v.visit_time = (SELECT MAX(visit_time) FROM history_visits WHERE history_item = i.id)
           ORDER BY v.visit_time DESC LIMIT ${HISTORY_LIMIT}`
        )
        .all() as { url: string; visits: number; time: number; title: string | null }[]
      db.close()
      return rows.map((r) => ({
        url: r.url,
        title: r.title ?? '',
        visits: Number(r.visits) || 1,
        lastVisit: Math.round((Number(r.time) + 978_307_200) * 1000)
      }))
    }
    if (sourceId === 'firefox') {
      const found = firefoxProfiles()
      if (found === 'blocked') throw new Error(blockedMessage('Firefox'))
      const profile = found.find((p) => p.dir === profileDir)
      if (!profile) throw new Error('That Firefox profile wasn’t found.')
      const db = new DatabaseSync(copyDatabase(join(profile.dir, 'places.sqlite'), 'places.sqlite', temp), { readOnly: true })
      const query = db.prepare(
        `SELECT url, title, visit_count, last_visit_date FROM moz_places
         WHERE visit_count > 0 AND hidden = 0 AND last_visit_date IS NOT NULL ORDER BY last_visit_date DESC LIMIT ${HISTORY_LIMIT}`
      )
      query.setReadBigInts(true)
      const rows = query.all() as { url: string; title: string | null; visit_count: bigint; last_visit_date: bigint }[]
      db.close()
      // Firefox counts microseconds from 1970.
      return rows.map((r) => ({
        url: r.url,
        title: r.title ?? '',
        visits: Number(r.visit_count),
        lastVisit: Number(r.last_visit_date / 1000n)
      }))
    }
    const browser = CHROMIUM_BROWSERS.find((b) => b.id === sourceId)
    if (!browser) throw new Error('That browser wasn’t found.')
    const found = profiles(browser)
    if (found === 'blocked') throw new Error(blockedMessage(browser.name))
    const profile = found.find((p) => p.dir === profileDir)
    if (!profile) throw new Error('That browser profile wasn’t found.')
    let copy: string
    try {
      copy = copyDatabase(join(browserRoot(browser) ?? '', profile.dir, 'History'), 'History', temp)
    } catch (error) {
      throw blocked(error) ? new Error(blockedMessage(browser.name)) : error
    }
    const db = new DatabaseSync(copy, { readOnly: true })
    const query = db.prepare(
      `SELECT url, title, visit_count, last_visit_time FROM urls WHERE hidden = 0 AND visit_count > 0 ORDER BY last_visit_time DESC LIMIT ${HISTORY_LIMIT}`
    )
    query.setReadBigInts(true)
    const rows = query.all() as { url: string; title: string; visit_count: bigint; last_visit_time: bigint }[]
    db.close()
    return rows.map((r) => ({
      url: r.url,
      title: r.title ?? '',
      visits: Number(r.visit_count),
      lastVisit: fromChromeTime(r.last_visit_time)
    }))
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

const blockedMessage = (name: string): string =>
  `macOS didn’t let Zepper read ${name}’s data. Allow Zepper in Privacy & Security › Full Disk Access, then try again.`

/** Chrome's timestamps count microseconds from 1601 (too large for a JavaScript number, so read as BigInt). */
const fromChromeTime = (value: bigint): number => Number(value / 1000n) - 11_644_473_600_000

/** Reads a Chromium browser's saved logins. Sites marked "never save" come back too. */
export async function importFromBrowser(sourceId: string, profileDir: string): Promise<{ entries: ImportEntry[]; neverSave: string[] }> {
  const browser = CHROMIUM_BROWSERS.find((b) => b.id === sourceId)
  if (!browser) throw new Error('That browser wasn’t found.')
  const found = profiles(browser)
  if (found === 'blocked') throw new Error(blockedMessage(browser.name))
  const profile = found.find((p) => p.dir === profileDir)
  if (!profile) throw new Error('That browser profile wasn’t found.')
  if (LINUX) throw new Error(`Export your passwords from ${browser.name} as a CSV file, then import the file.`)
  const secret = await readKeychain(browser.service, browser.account)
  if (secret === null) throw new Error(`Zepper needs access to ${browser.name}’s key in your Keychain. Try again and choose Allow.`)
  const key = pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1')

  // The browser may have the database open; read a copy.
  const temp = mkdtempSync(join(app.getPath('temp'), 'zepper-import-'))
  const copy = join(temp, 'Login Data')
  try {
    try {
      copyFileSync(join(browserRoot(browser) ?? '', profile.dir, 'Login Data'), copy)
    } catch (error) {
      throw blocked(error) ? new Error(blockedMessage(browser.name)) : error
    }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(copy, { readOnly: true })
    const query = db.prepare(
      'SELECT origin_url, signon_realm, username_value, password_value, date_created, blacklisted_by_user FROM logins'
    )
    query.setReadBigInts(true)
    const rows = query.all() as {
      origin_url: string
      signon_realm: string
      username_value: string
      password_value: Uint8Array
      date_created: bigint
      blacklisted_by_user: bigint
    }[]
    db.close()
    const entries: ImportEntry[] = []
    const neverSave = new Set<string>()
    for (const row of rows) {
      const url = row.origin_url || row.signon_realm
      if (Number(row.blacklisted_by_user)) {
        try {
          neverSave.add(new URL(url).hostname)
        } catch {
          // Not a web address.
        }
        continue
      }
      const password = decrypt(Buffer.from(row.password_value), key)
      if (password === null) continue
      entries.push({ url, username: row.username_value ?? '', password, created: fromChromeTime(row.date_created) })
    }
    return { entries, neverSave: [...neverSave] }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

/** Chromium on macOS: "v10" + AES-128-CBC with a fixed IV of spaces. */
function decrypt(value: Buffer, key: Buffer): string | null {
  if (value.length === 0) return null
  if (value.subarray(0, 3).toString('latin1') !== 'v10') return value.toString('utf8')
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
    return Buffer.concat([decipher.update(value.subarray(3)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

// ---- CSV ----

/** RFC 4180 CSV: quoted fields, doubled quotes, line breaks inside quotes, and a byte-order mark. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const input = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

const COLUMNS = {
  url: ['url', 'login_uri', 'website', 'web site', 'uri', 'login url', 'hostname', 'origin', 'web address'],
  username: ['username', 'login_username', 'user name', 'login', 'user', 'login name'],
  email: ['email', 'e-mail', 'login_email'],
  password: ['password', 'login_password'],
  note: ['note', 'notes', 'extra', 'comments'],
  created: ['timecreated', 'createtime', 'created'],
  type: ['type']
} as const

/** Logins from a password CSV, whichever app exported it (columns are matched by name). */
export function entriesFromCsv(text: string): ImportEntry[] {
  const [header, ...rows] = parseCsv(text)
  if (!header) throw new Error('That file is empty.')
  const names = header.map((h) => h.trim().toLowerCase())
  const column = (key: keyof typeof COLUMNS): number => names.findIndex((name) => (COLUMNS[key] as readonly string[]).includes(name))
  const url = column('url')
  const password = column('password')
  if (url < 0 || password < 0) throw new Error('That file doesn’t look like a password export (it needs URL and password columns).')
  const username = column('username')
  const email = column('email')
  const note = column('note')
  const created = column('created')
  const type = column('type')
  return rows.flatMap((row) => {
    // Bitwarden and Proton Pass also export notes and cards; only logins come in.
    if (type >= 0 && row[type] && !/^login$/i.test(row[type].trim())) return []
    const time = created >= 0 ? Number(row[created]) : NaN
    return [
      {
        // Some apps list several addresses in one cell; the first is the site.
        url: (row[url] ?? '').split(/[,\s]+/)[0] ?? '',
        username: (username >= 0 && row[username]) || (email >= 0 ? (row[email] ?? '') : ''),
        password: row[password] ?? '',
        note: note >= 0 ? row[note] : undefined,
        // Seconds or milliseconds since 1970.
        created: Number.isFinite(time) && time > 0 ? (time < 1e11 ? time * 1000 : time) : undefined
      }
    ]
  })
}

/** A browser's open tabs (Arc: its spaces), with the browser's name for spaces made from its windows. */
export function importOpenTabs(sourceId: string, profileDir: string): { session: ImportedSession; name: string } {
  if (sourceId === 'firefox') {
    try {
      return { session: importTabs('firefox', profileDir), name: 'Firefox' }
    } catch (error) {
      if (blocked(error)) throw new Error(blockedMessage('Firefox'), { cause: error })
      throw error
    }
  }
  const browser = CHROMIUM_BROWSERS.find((b) => b.id === sourceId)
  if (!browser) throw new Error('Zepper can’t import open tabs from that browser')
  const root = browserRoot(browser) ?? ''
  try {
    return {
      session: importTabs(sourceId === 'arc' ? 'arc' : 'chromium', profileDir === '.' ? root : join(root, profileDir)),
      name: browser.name
    }
  } catch (error) {
    if (blocked(error)) throw new Error(blockedMessage(browser.name), { cause: error })
    throw error
  }
}
