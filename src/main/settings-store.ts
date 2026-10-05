import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'
import { JsonFile } from './persist'

/** User preferences, persisted to settings.json and merged over the defaults. */
export class SettingsStore {
  private readonly file = new JsonFile<Partial<Settings>>('settings.json', 300)
  private value: Settings
  private readonly listeners = new Set<(next: Settings, prev: Settings) => void>()

  constructor() {
    const saved: Partial<Settings> & { windowTransparency?: number } = this.file.read() ?? {}
    // Transparency used to top out at what is now 50% (the scale now goes further); keep the same look.
    if (saved.windowTransparency !== undefined && saved.transparency === undefined) saved.transparency = saved.windowTransparency / 2
    delete saved.windowTransparency
    this.value = { ...DEFAULT_SETTINGS, ...saved }
  }

  get(): Settings {
    return this.value
  }

  update(patch: Partial<Settings>): void {
    const prev = this.value
    this.value = { ...prev, ...patch }
    this.file.schedule(this.value)
    for (const listener of this.listeners) listener(this.value, prev)
  }

  onChange(listener: (next: Settings, prev: Settings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  flush(): void {
    this.file.flush()
  }
}
