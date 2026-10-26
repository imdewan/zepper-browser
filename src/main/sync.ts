import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import {
  base64url,
  decodeCode,
  deriveKeys,
  documentId,
  encodeCode,
  fromBase64url,
  newSecret,
  open,
  seal,
  type ChainKeys,
  type DeviceRecord,
  type SendRecord
} from '@shared/sync-protocol'
import { Relay, type RelayChange } from '@shared/sync-relay'
import type { SyncSnapshot } from '@shared/types'
import { JsonFile } from './persist'
import { type Change, type SharedRecord } from './sync-model'
import config from './sync-config.json'

/**
 * Zepper Sync: this computer's spaces, Essentials, pinned tabs and folders, the same as on your other
 * devices (Zepper for iPhone). Devices pair with a code (a QR code for the phone); everything they
 * keep on Zepper's sync server is encrypted with it (sync-protocol.ts, sync-relay.ts). The main window
 * is what syncs; other windows and private ones don't.
 */

/** What sync needs from the main window. */
export interface SyncedWindow {
  syncRecords(orders: Map<string, string>): SharedRecord[]
  applySynced(changes: Change[], orders: Map<string, string>): void
  syncTabs(): DeviceRecord['tabs']
  openSentTab(url: string, from: string): void
}

interface Saved {
  /** The secret, encrypted with the system's keychain (safeStorage). */
  secret?: string
  deviceId: string
  deviceName?: string
  /** Each synced item's fractional index (see sync-model.ts). */
  orders?: Record<string, string>
}

const PUSH_DELAY_MS = 800
const DEVICE_DELAY_MS = 15_000
/** Records per write, at most (the server takes 500). */
const BATCH = 400
/** How long leaving or quitting waits to tell the others, offline. */
const LEAVE_WAIT_MS = 3000

/** Zepper's sync server, or another (development: ZEPPER_SYNC_SERVER=ws://127.0.0.1:8787, from sync-server/). */
const SERVER = process.env.ZEPPER_SYNC_SERVER || config.server

export class SyncService {
  private readonly file = new JsonFile<Saved>('sync.json', 500)
  private saved: Saved
  private orders = new Map<string, string>()
  private window: SyncedWindow | null = null
  private keys: ChainKeys | null = null
  private relay: Relay | null = null
  private known = new Map<string, SharedRecord>()
  private devices = new Map<string, DeviceRecord>()
  private ready = false
  private applying = false
  private pushTimer: NodeJS.Timeout | null = null
  private deviceTimer: NodeJS.Timeout | null = null
  private lastDevice = ''
  private status: SyncSnapshot['status'] = { kind: 'off' }
  /** The code, while Settings is showing it. */
  private shownCode: string | null = null
  private computerName = hostname().replace(/\.local$/, '')

  constructor(private readonly changed: () => void) {
    this.saved = this.file.read() ?? { deviceId: crypto.randomUUID() }
    this.orders = new Map(Object.entries(this.saved.orders ?? {}))
    if (process.platform === 'darwin') {
      execFile('scutil', ['--get', 'ComputerName'], (error, out) => {
        if (!error && out.trim()) this.computerName = out.trim()
      })
    }
    // Firebase's sign-in, from before sync had its own server.
    void unlink(join(app.getPath('userData'), 'sync-auth.json')).catch(() => {})
  }

  get available(): boolean {
    return !!SERVER
  }

  snapshot(): SyncSnapshot {
    return {
      status: this.available ? this.status : { kind: 'unavailable' },
      deviceName: this.deviceName(),
      devices: [...this.devices.values()]
        .sort((a, b) => b.seenAt - a.seenAt)
        .map(({ id, name, platform, seenAt, tabs }) => ({ id, name, platform, seenAt, tabs })),
      code: this.shownCode
    }
  }

  private deviceName(): string {
    return this.saved.deviceName || this.computerName || 'Computer'
  }

  /** The window that syncs (the main window), once it's open. */
  attach(window: SyncedWindow): void {
    this.window = window
    if (this.secret()) void this.begin()
  }

  detach(window: SyncedWindow): void {
    if (this.window !== window) return
    void this.pushDevice(true)
    this.window = null
  }

  /** The window's spaces or pins changed (or its tabs: they're published too). */
  noteChange(tabsOnly = false): void {
    if (!this.ready || this.applying || !this.window) return
    if (!tabsOnly) {
      if (this.pushTimer) clearTimeout(this.pushTimer)
      this.pushTimer = setTimeout(() => void this.push(), PUSH_DELAY_MS)
    }
    this.deviceTimer ??= setTimeout(() => {
      this.deviceTimer = null
      void this.pushDevice(false)
    }, DEVICE_DELAY_MS)
  }

  /** Starts a chain on this computer; its code goes in Settings for your phone to scan. */
  async start(): Promise<void> {
    const secret = newSecret()
    this.saveSecret(secret)
    this.shownCode = encodeCode(secret)
    await this.begin()
  }

  /** Joins the chain of the device whose code you typed. */
  async join(code: string): Promise<boolean> {
    const secret = decodeCode(code)
    if (!secret) return false
    this.saveSecret(secret)
    this.shownCode = null
    // What's on this computer joins what's there: nothing is dropped.
    await this.begin()
    return true
  }

  showCode(show: boolean): void {
    const secret = this.secret()
    this.shownCode = show && secret ? encodeCode(secret) : null
    this.changed()
  }

  async leave(): Promise<void> {
    if (this.relay && this.keys) {
      const gone = this.relay.remove([documentId(this.keys, 'device', this.saved.deviceId)])
      await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, LEAVE_WAIT_MS))])
    }
    this.stop()
    this.saved = { deviceId: this.saved.deviceId, deviceName: this.saved.deviceName }
    this.orders.clear()
    this.file.schedule(this.saved)
    this.shownCode = null
    this.status = { kind: 'off' }
    this.devices.clear()
    this.changed()
  }

  rename(name: string): void {
    this.saved.deviceName = name.trim() || undefined
    this.file.schedule(this.saved)
    void this.pushDevice(true)
    this.changed()
  }

  async sendTab(deviceId: string, url: string, title: string): Promise<void> {
    if (!this.relay || !this.keys) return
    const record: SendRecord = {
      type: 'send',
      id: crypto.randomUUID(),
      to: deviceId,
      from: this.saved.deviceId,
      url,
      title,
      at: Date.now()
    }
    const docId = documentId(this.keys, 'send', record.id)
    await this.relay.put([{ doc: docId, c: seal(this.keys, docId, record) }])
  }

  /** Before quitting: the window's last changes, and this computer's tabs (waiting a moment, offline). */
  async flush(): Promise<void> {
    if (!this.ready) return
    const sent = (async () => {
      if (this.pushTimer) await this.push()
      await this.pushDevice(true)
    })()
    await Promise.race([sent, new Promise((resolve) => setTimeout(resolve, LEAVE_WAIT_MS))])
    this.saveOrders()
    this.file.flush()
  }

  // ---- The chain ---------------------------------------------------------------------------------

  private secret(): Uint8Array | null {
    if (!this.saved.secret) return null
    try {
      const text = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(this.saved.secret, 'base64'))
        : this.saved.secret
      return fromBase64url(text)
    } catch {
      return null
    }
  }

  private saveSecret(secret: Uint8Array): void {
    const text = base64url(secret)
    this.saved.secret = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text).toString('base64') : text
    this.orders.clear()
    this.saved.orders = {}
    this.file.schedule(this.saved)
  }

  private async begin(): Promise<void> {
    const secret = this.secret()
    if (!secret || !this.available) return
    this.stop()
    this.status = { kind: 'connecting' }
    this.changed()
    const keys = deriveKeys(secret)
    this.keys = keys
    this.relay = new Relay(`${SERVER}/v1/chains/${keys.chainId}`, keys.access, {
      changes: (changes) => this.received(changes),
      status: (status) => {
        // Connected shows once the chain is in (received).
        if (status.kind === 'connected') return
        this.status = status.kind === 'error' ? { kind: 'error', message: status.message } : { kind: 'connecting' }
        this.changed()
      }
    })
    this.relay.start()
  }

  private stop(): void {
    this.relay?.close()
    this.relay = null
    this.ready = false
    this.known.clear()
    this.devices.clear()
    if (this.pushTimer) clearTimeout(this.pushTimer)
    if (this.deviceTimer) clearTimeout(this.deviceTimer)
    this.pushTimer = this.deviceTimer = null
  }

  private received(incoming: RelayChange[]): void {
    if (!this.keys) return
    const changes: Change[] = []
    for (const change of incoming) {
      const docId = change.doc
      const gone = change.type === 'removed' || !change.data.c
      const record = gone ? null : open(this.keys, docId, change.data.c!)
      // From a newer Zepper: leave it be.
      if (!gone && !record) continue
      if (record?.type === 'device') {
        if (record.id !== this.saved.deviceId) this.devices.set(docId, record)
        continue
      }
      if (record?.type === 'send') {
        if (record.to === this.saved.deviceId) {
          const from = this.devices.get(documentId(this.keys, 'device', record.from))?.name ?? 'another device'
          this.window?.openSentTab(record.url, from)
          void this.relay?.remove([docId])
        }
        continue
      }
      if (!record) {
        this.devices.delete(docId)
        const previous = this.known.get(docId)
        if (previous) changes.push({ record: null, previous })
        this.known.delete(docId)
        continue
      }
      changes.push({ record, previous: this.known.get(docId) })
      this.known.set(docId, record)
    }

    this.ready = true
    if (changes.length > 0 && this.window) {
      this.applying = true
      try {
        this.window.applySynced(changes, this.orders)
      } finally {
        this.applying = false
      }
      this.saveOrders()
    }
    void this.push()
    void this.pushDevice(false)
    this.status = { kind: 'on', devices: this.devices.size }
    this.changed()
  }

  private async push(): Promise<void> {
    this.pushTimer = null
    if (!this.window || !this.relay || !this.keys) return
    const keys = this.keys
    const relay = this.relay
    const present = new Set<string>()
    const writes: { docId: string; record: SharedRecord }[] = []
    for (const record of this.window.syncRecords(this.orders)) {
      const docId = documentId(keys, record.type, record.id)
      present.add(docId)
      const theirs = this.known.get(docId)
      if (!theirs || fingerprint(theirs) !== fingerprint(record)) writes.push({ docId, record })
    }
    const deletes = [...this.known.keys()].filter((docId) => !present.has(docId))
    if (writes.length === 0 && deletes.length === 0) return
    for (const w of writes) this.known.set(w.docId, w.record)
    for (const docId of deletes) this.known.delete(docId)
    this.saveOrders()
    // Deleted ones keep their document a while (c: null), so devices that were away hear of it.
    const docs = [
      ...writes.map((w) => ({ doc: w.docId, c: seal(keys, w.docId, w.record) })),
      ...deletes.map((docId) => ({ doc: docId, c: null }))
    ]
    for (let i = 0; i < docs.length; i += BATCH) await relay.put(docs.slice(i, i + BATCH))
  }

  private async pushDevice(force: boolean): Promise<void> {
    if (!this.window || !this.relay || !this.keys || !this.ready) return
    const tabs = this.window.syncTabs()
    const fingerprint = JSON.stringify([this.deviceName(), tabs])
    if (!force && fingerprint === this.lastDevice) return
    this.lastDevice = fingerprint
    const record: DeviceRecord = {
      type: 'device',
      id: this.saved.deviceId,
      name: this.deviceName(),
      platform: platform(),
      seenAt: Date.now(),
      tabs
    }
    const docId = documentId(this.keys, 'device', record.id)
    await this.relay.put([{ doc: docId, c: seal(this.keys, docId, record) }])
  }

  private saveOrders(): void {
    this.saved.orders = Object.fromEntries(this.orders)
    this.file.schedule(this.saved)
  }
}

function fingerprint(record: SharedRecord): string {
  return JSON.stringify(record, Object.keys(record).sort())
}

function platform(): DeviceRecord['platform'] {
  return process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux'
}
