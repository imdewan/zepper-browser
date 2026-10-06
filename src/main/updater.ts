import { app, net } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, chmodSync, constants, createWriteStream, existsSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { UpdateStatus } from '@shared/types'

/**
 * Updates, the way Chrome does them: Zepper checks GitHub Releases in the background, downloads a
 * newer version and unpacks it next to your profile, then shows an Update button. Clicking it
 * restarts into the new version; quitting normally installs it too, so the next launch is updated.
 *
 * The feed is electron-builder's latest-mac.yml on the latest release (its sha512 checks the
 * download). Installing swaps the app bundle once Zepper has quit, using a small shell script, so
 * it works without Squirrel (which needs a Developer ID signature to trust an update).
 */

const REPOSITORY = 'imdewan/zepper-browser'
const FEED = `https://github.com/${REPOSITORY}/releases/latest/download`
export const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases/latest`
const FIRST_CHECK_MS = 10_000
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

const run = promisify(execFile)

interface Release {
  version: string
  file: string
  sha512: string
  size: number
}

interface Staged {
  version: string
  app: string
}

/** Swaps the app bundle once Zepper has quit, then (optionally) opens the new one. */
const INSTALL_SCRIPT = `#!/bin/sh
pid="$1"; new="$2"; app="$3"; relaunch="$4"; stage="$5"
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1))
  [ "$n" -gt 600 ] && exit 1
  sleep 0.1
done
old="$app.previous"
rm -rf "$old"
if mv "$app" "$old"; then
  if mv "$new" "$app"; then rm -rf "$old"; else mv "$old" "$app"; fi
fi
xattr -dr com.apple.quarantine "$app" 2>/dev/null
rm -rf "$stage"
if [ "$relaunch" = 1 ]; then
  if [ -n "$ZEPPER_PROFILE" ]; then open -n "$app" --env "ZEPPER_PROFILE=$ZEPPER_PROFILE"; else open "$app"; fi
fi
`

/** 1 if a is newer than b, -1 if older, 0 if the same ("0.2.0" vs "0.1.10"). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split(/[.+-]/)
      .map((n) => parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1
  }
  return 0
}

/** The zip for this Mac from electron-builder's latest-mac.yml. */
export function parseFeed(text: string): Release | null {
  const value = (source: string, key: string): string =>
    new RegExp(`^\\s*-?\\s*${key}:\\s*(.+?)\\s*$`, 'm').exec(source)?.[1]?.replace(/^['"]|['"]$/g, '') ?? ''
  const version = value(text, 'version')
  const files = text
    .split(/^\s*-\s+url:/m)
    .slice(1)
    .map((entry) => `url:${entry}`)
    .map((entry) => ({ file: value(entry, 'url'), sha512: value(entry, 'sha512'), size: Number(value(entry, 'size')) || 0 }))
    .filter((f) => f.file.endsWith('.zip') && f.sha512)
  const file = files.find((f) => f.file.includes(`-${process.arch}.`)) ?? files[0]
  return version && file ? { version, ...file } : null
}

export class Updater {
  status: UpdateStatus
  private readonly feed: string | null
  private readonly dir = join(app.getPath('userData'), 'Updates')
  private staged: Staged | null = null
  private relaunch = false
  private busy = false

  constructor(
    private readonly onChange: () => void,
    /** Background checks and downloads (Settings › General); checking by hand always works. */
    private readonly automatic: () => boolean
  ) {
    this.feed = process.env['ZEPPER_UPDATE_FEED'] || (app.isPackaged ? FEED : null)
    this.status = this.feed ? { state: 'idle' } : { state: 'off' }
  }

  start(): void {
    if (!this.feed) return
    void this.restoreStaged()
    const background = (): void => {
      if (this.automatic()) void this.check()
    }
    setTimeout(background, FIRST_CHECK_MS)
    setInterval(background, CHECK_EVERY_MS).unref()
    // Quitting with an update ready installs it (and Update restarts into it).
    app.on('will-quit', () => this.install())
  }

  /** Looks for a newer version and downloads it. `manual`: you asked (About), so failures are shown. */
  async check(manual = false): Promise<void> {
    if (!this.feed || this.busy || this.status.state === 'ready') return
    this.busy = true
    if (manual) this.set({ state: 'checking' })
    try {
      const response = await net.fetch(`${this.feed}/latest-mac.yml`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`The update feed answered ${response.status}`)
      const release = parseFeed(await response.text())
      if (!release) throw new Error('The update feed couldn’t be read')
      if (compareVersions(release.version, app.getVersion()) <= 0) return this.set({ state: 'current' })
      // Installed somewhere Zepper can't replace itself (a disk image, a read-only folder): offer the download.
      if (!this.target()) return this.set({ state: 'manual', version: release.version })
      await this.download(release)
    } catch (error) {
      console.warn('[update] check failed', error)
      this.set(manual ? { state: 'error', message: 'Couldn’t check for updates' } : { state: 'idle' })
    } finally {
      this.busy = false
    }
  }

  /** Restarts into the downloaded version. */
  restartToUpdate(): boolean {
    if (!this.staged || !this.target()) return false
    this.relaunch = true
    return true
  }

  /** The app bundle to replace, if Zepper can replace it. */
  private target(): string | null {
    if (!app.isPackaged) return null
    const bundle = resolve(dirname(process.execPath), '..', '..')
    if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) return null
    try {
      accessSync(dirname(bundle), constants.W_OK)
      accessSync(bundle, constants.W_OK)
      return bundle
    } catch {
      return null
    }
  }

  private async download(release: Release): Promise<void> {
    await rm(this.dir, { recursive: true, force: true })
    await mkdir(this.dir, { recursive: true })
    const zip = join(this.dir, release.file)
    this.set({ state: 'downloading', version: release.version, progress: 0 })
    const response = await net.fetch(`${this.feed}/${encodeURIComponent(release.file)}`, { cache: 'no-store' })
    if (!response.ok || !response.body) throw new Error(`The download answered ${response.status}`)
    const hash = createHash('sha512')
    const out = createWriteStream(zip)
    const reader = response.body.getReader()
    let received = 0
    let shown = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      received += value.length
      if (!out.write(value)) await new Promise((r) => out.once('drain', r))
      const progress = release.size ? Math.min(1, received / release.size) : 0
      if (progress - shown >= 0.02) {
        shown = progress
        this.set({ state: 'downloading', version: release.version, progress })
      }
    }
    await new Promise<void>((done, fail) => out.end((error?: Error | null) => (error ? fail(error) : done())))
    if (hash.digest('base64') !== release.sha512) throw new Error('The download didn’t match the release')

    // ditto keeps the bundle's symlinks and signature intact.
    const unpacked = join(this.dir, release.version)
    await run('ditto', ['-x', '-k', zip, unpacked])
    await rm(zip, { force: true })
    const name = (await readdir(unpacked)).find((entry) => entry.endsWith('.app'))
    if (!name) throw new Error('The download has no app in it')
    const bundle = join(unpacked, name)
    await this.verify(bundle, release.version)
    this.staged = { version: release.version, app: bundle }
    await writeFile(join(this.dir, 'staged.json'), JSON.stringify(this.staged))
    this.set({ state: 'ready', version: release.version })
  }

  /** It's Zepper, it's the version the feed promised, and its signature is intact. */
  private async verify(bundle: string, version: string): Promise<void> {
    const plist = join(bundle, 'Contents', 'Info.plist')
    const read = async (key: string): Promise<string> => (await run('plutil', ['-extract', key, 'raw', plist])).stdout.trim()
    if ((await read('CFBundleIdentifier')) !== 'app.zepper.browser') throw new Error('The download isn’t Zepper')
    if ((await read('CFBundleShortVersionString')) !== version) throw new Error('The download is a different version')
    await run('codesign', ['--verify', '--deep', '--strict', bundle])
  }

  /** An update downloaded before the last quit (that didn't get installed) is still ready. */
  private async restoreStaged(): Promise<void> {
    try {
      const staged = JSON.parse(await readFile(join(this.dir, 'staged.json'), 'utf8')) as Staged
      if (compareVersions(staged.version, app.getVersion()) > 0 && existsSync(staged.app) && this.target()) {
        this.staged = staged
        this.set({ state: 'ready', version: staged.version })
      } else {
        await rm(this.dir, { recursive: true, force: true })
      }
    } catch {
      // Nothing staged.
    }
  }

  /** On quit: hands the staged update to the install script, which waits for Zepper to exit. */
  private install(): void {
    const target = this.target()
    if (!this.staged || !target || !existsSync(this.staged.app)) return
    const script = join(this.dir, 'install.sh')
    try {
      // Written synchronously: will-quit doesn't wait for promises.
      writeFileSync(script, INSTALL_SCRIPT)
      chmodSync(script, 0o755)
      const child = spawn('/bin/sh', [script, String(process.pid), this.staged.app, target, this.relaunch ? '1' : '0', this.dir], {
        detached: true,
        stdio: 'ignore'
      })
      child.unref()
      this.staged = null
    } catch (error) {
      console.warn('[update] could not start the installer', error)
    }
  }

  private set(status: UpdateStatus): void {
    this.status = status
    this.onChange()
  }
}
