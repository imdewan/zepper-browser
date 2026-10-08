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
  }

  flush(): void {
    this.history.flush()
    this.semantic.flush()
    this.permissions.flush()
  }

  /** Deletes all of it. */
  discard(): void {
    this.history.discard()
    this.semantic.discard()
    this.vault.discard()
    this.permissions.discard()
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
  separate(existing: string[]): void {
    const marker = join(app.getPath('userData'), SEPARATED)
    if (existsSync(marker)) return
    for (const id of new Set(existing)) if (id !== DEFAULT_PROFILE) this.copy(DEFAULT_PROFILE, id)
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, `${new Date().toISOString()}\n`)
  }

  /** A profile started from another space's (Copy From): its passwords, passkeys and site permissions come too. */
  copy(from: string, to: string): void {
    const source = this.get(from)
    const target = this.get(to)
    target.vault.mergeFrom(source.vault)
    target.permissions.mergeFrom(source.permissions)
  }

  /**
   * A profile no space uses any more: its passwords and passkeys move to the default profile, so none
   * are lost, and the rest of its data is deleted. Returns how many passwords and passkeys moved.
   */
  retire(id: string): number {
    if (id === DEFAULT_PROFILE) return 0
    const data = this.get(id)
    const moved = this.default.vault.mergeFrom(data.vault)
    data.discard()
    this.opened.delete(id)
    return moved
  }
}
