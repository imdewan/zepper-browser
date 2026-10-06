import { app } from 'electron'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ImportSource } from '@shared/types'
import { readKeychain } from './native'
import type { ImportEntry } from './vault'

/**
 * Bringing passwords into Zepper: straight from Chromium-based browsers on this Mac (their saved
 * logins, decrypted with the key they keep in the Keychain, which macOS asks you to allow), or
 * from a CSV export: Apple Passwords and Safari, Firefox, Chrome, 1Password, Bitwarden, LastPass,
 * Proton Pass and others.
 */

interface ChromiumBrowser {
  id: string
  name: string
  /** Under ~/Library/Application Support. */
  dir: string
  /** The Keychain item holding its encryption key. */
  service: string
  account: string
}

const CHROMIUM_BROWSERS: ChromiumBrowser[] = [
  { id: 'chrome', name: 'Google Chrome', dir: 'Google/Chrome', service: 'Chrome Safe Storage', account: 'Chrome' },
  { id: 'chrome-beta', name: 'Chrome Beta', dir: 'Google/Chrome Beta', service: 'Chrome Safe Storage', account: 'Chrome' },
  { id: 'brave', name: 'Brave', dir: 'BraveSoftware/Brave-Browser', service: 'Brave Safe Storage', account: 'Brave' },
  { id: 'edge', name: 'Microsoft Edge', dir: 'Microsoft Edge', service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' },
  { id: 'arc', name: 'Arc', dir: 'Arc/User Data', service: 'Arc Safe Storage', account: 'Arc' },
  { id: 'vivaldi', name: 'Vivaldi', dir: 'Vivaldi', service: 'Vivaldi Safe Storage', account: 'Vivaldi' },
  { id: 'opera', name: 'Opera', dir: 'com.operasoftware.Opera', service: 'Opera Safe Storage', account: 'Opera' },
  { id: 'helium', name: 'Helium', dir: 'net.imput.helium', service: 'Helium Storage Key', account: 'Helium' },
  { id: 'chromium', name: 'Chromium', dir: 'Chromium', service: 'Chromium Safe Storage', account: 'Chromium' }
]

const supportDir = (): string => join(homedir(), 'Library', 'Application Support')

const blocked = (error: unknown): boolean => ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException)?.code ?? '')

/**
 * Profile folders holding saved logins ("Default", "Profile 1"…, or the browser folder itself, as
 * Opera does). macOS protects some browsers' data from other apps until you allow it: then all
 * that's known is that the browser is there.
 */
function profiles(browser: ChromiumBrowser): { dir: string; name: string }[] | 'blocked' {
  const root = join(supportDir(), browser.dir)
  if (!existsSync(root)) return []
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
  if (existsSync(join(root, 'Login Data'))) found.push({ dir: '.', name: 'Default' })
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(Default|Profile \d+)$/.test(entry.name)) continue
    if (existsSync(join(root, entry.name, 'Login Data'))) found.push({ dir: entry.name, name: names[entry.name]?.name || entry.name })
  }
  return found
}

/** Browsers on this Mac with saved passwords Zepper can import. */
export function importSources(): ImportSource[] {
  if (process.platform !== 'darwin') return []
  return CHROMIUM_BROWSERS.flatMap((browser) => {
    const found = profiles(browser)
    if (found === 'blocked') return [{ id: browser.id, name: browser.name, profiles: [], blocked: true }]
    return found.length ? [{ id: browser.id, name: browser.name, profiles: found }] : []
  })
}

const blockedMessage = (name: string): string =>
  `macOS didn’t let Zepper read ${name}’s data. Allow Zepper in Privacy & Security › Full Disk Access, or export a passwords file from ${name} and import that.`

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
  const secret = await readKeychain(browser.service, browser.account)
  if (secret === null) throw new Error(`Zepper needs access to ${browser.name}’s key in your Keychain. Try again and choose Allow.`)
  const key = pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1')

  // The browser may have the database open; read a copy.
  const temp = mkdtempSync(join(app.getPath('temp'), 'zepper-import-'))
  const copy = join(temp, 'Login Data')
  try {
    try {
      copyFileSync(join(supportDir(), browser.dir, profile.dir, 'Login Data'), copy)
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
