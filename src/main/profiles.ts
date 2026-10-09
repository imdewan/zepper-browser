import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { History } from './history'
import { SemanticHistory } from './semantic'
import { SitePermissions } from './site'
import { Vault } from './vault'

/** The profile Essentials, extensions and your first space use (Electron's default session). */
export const DEFAULT_PROFILE = 'default'
/** Where the other profiles keep their data, a folder each. */
const PROFILES_DIR = 'profiles'
/** Written once the profiles that already existed got their own data (see Profiles.separate). */
const SEPARATED = join(PROFILES_DIR, 'separated')

/**
 * A profile's own data: its history (and history by meaning), saved passwords and passkeys, and
 * site permissions. A profile also has its own cookies and storage (its session), and its downloads
 * are marked as its own in Downloads. The default profile's files are where they always were.
 */
export class ProfileData {
  readonly history: History
  readonly semantic: SemanticHistory
  readonly vault: Vault
  readonly permissions: SitePermissions

  constructor(readonly id: string) {
    const dir = id === DEFAULT_PROFILE ? '' : `${PROFILES_DIR}/${id}/`
    this.history = new History(`${dir}history.json`)
    this.semantic = new SemanticHistory(this.history, `${dir}history-meaning.json`)
    this.vault = new Vault(`${dir}passwords.vault`)
    this.permissions = new SitePermissions(`${dir}site-settings.json`)
    // Read now, in the background, so the passwords are there when a sign-in form asks (and if macOS
    // wants you to allow its Keychain key, it asks while Zepper opens).
    void this.vault.ready()
  }

  flush(): void {
    this.history.flush()
    this.semantic.flush()
    this.permissions.flush()
  }

  /** Deletes all of it. */
  async discard(): Promise<void> {
    this.history.discard()
    this.semantic.discard()
    this.permissions.discard()
    await this.vault.discard()
    if (this.id !== DEFAULT_PROFILE) rmSync(join(app.getPath('userData'), PROFILES_DIR, this.id), { recursive: true, force: true })
  }
}

/** Every profile's data, opened when it's first needed. */
export class Profiles {
  private readonly opened = new Map<string, ProfileData>()

  /** `onOpen`: a profile's data was opened (to hear about its changes). */
  constructor(private readonly onOpen: (data: ProfileData) => void) {}

  get(id: string): ProfileData {
    let data = this.opened.get(id)
    if (!data) {
      data = new ProfileData(id)
      this.opened.set(id, data)
      this.onOpen(data)
    }
    return data
  }

  get default(): ProfileData {
    return this.get(DEFAULT_PROFILE)
  }

  /** The profiles opened so far (for saving on quit). */
  open(): ProfileData[] {
    return [...this.opened.values()]
  }

  /** Every profile with data on this Mac, opened or not (for clearing everyone's history). */
  all(): ProfileData[] {
    let ids: string[] = []
    try {
      ids = readdirSync(join(app.getPath('userData'), PROFILES_DIR), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      // No other profiles yet.
    }
    return [DEFAULT_PROFILE, ...ids].map((id) => this.get(id))
  }

  /**
   * Once, after the update that gave each profile its own data: the profiles that existed before
   * (spaces with their own sign-ins) start with what they were using until then, the shared
   * passwords, passkeys and site permissions, so nothing that worked stops working. History stays
   * with the default profile.
   */
  async separate(existing: string[]): Promise<void> {
    const marker = join(app.getPath('userData'), SEPARATED)
    if (existsSync(marker)) return
    let copied = true
    for (const id of new Set(existing)) if (id !== DEFAULT_PROFILE) copied = (await this.copy(DEFAULT_PROFILE, id)) && copied
    // Tried again next time if the passwords couldn't be opened.
    if (!copied) return
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, `${new Date().toISOString()}\n`)
  }

  /**
   * A profile started from another space's (Copy From): its passwords, passkeys and site permissions
   * come too. False if the passwords couldn't be opened (macOS kept the Keychain key).
   */
  async copy(from: string, to: string): Promise<boolean> {
    const source = this.get(from)
    const target = this.get(to)
    target.permissions.mergeFrom(source.permissions)
    return (await target.vault.mergeFrom(source.vault)) !== null
  }

  /**
   * A profile no space uses any more: its passwords and passkeys move to the default profile, so none
   * are lost, and the rest of its data is deleted. Returns how many passwords and passkeys moved. If
   * they couldn't be opened, the profile's data stays where it is (it can be retired another time).
   */
  async retire(id: string): Promise<number> {
    if (id === DEFAULT_PROFILE) return 0
    const data = this.get(id)
    const moved = await this.default.vault.mergeFrom(data.vault)
    if (moved === null) return 0
    this.opened.delete(id)
    await data.discard()
    return moved
  }

  /** Waits for every profile's password saves under way (before quitting). */
  async written(): Promise<void> {
    await Promise.all(this.open().map((data) => data.vault.written()))
  }
}
