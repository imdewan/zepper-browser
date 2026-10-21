import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { safeStorage } from 'electron'
import { initializeApp } from 'firebase/app'
import { connectAuthEmulator, initializeAuth, signInAnonymously, type Auth, type Persistence } from 'firebase/auth'
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  initializeFirestore,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  type CollectionReference,
  type Firestore,
  type QuerySnapshot,
  type Timestamp
} from 'firebase/firestore'
import {
  base64url,
  decodeCode,
  deriveKeys,
  documentId,
  encodeCode,
  fromBase64url,
  newSecret,
  open,
  PROTOCOL_VERSION,
  seal,
  type ChainKeys,
  type DeviceRecord,
  type SendRecord,
  type StoredRecord
} from '@shared/sync-protocol'
import type { SyncSnapshot } from '@shared/types'
import { JsonFile } from './persist'
import { type Change, type SharedRecord } from './sync-model'
import config from './sync-config.json'

/**
 * Zepper Sync: this computer's spaces, Essentials, pinned tabs and folders, the same as on your other
 * devices (Zepper for iPhone). Devices pair with a code (a QR code for the phone); everything they
 * keep in the shared Firestore is encrypted with it (sync-protocol.ts). The main window is what syncs;
 * other windows and private ones don't.
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
const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000
const BATCH = 400

/** The Firebase emulators, for development (ZEPPER_SYNC_EMULATOR=127.0.0.1). */
const EMULATOR = process.env.ZEPPER_SYNC_EMULATOR || null

export class SyncService {
  private readonly file = new JsonFile<Saved>('sync.json', 500)
  private saved: Saved
  private orders = new Map<string, string>()
  private window: SyncedWindow | null = null
  private keys: ChainKeys | null = null
  private records: CollectionReference | null = null
  private services: { auth: Auth; db: Firestore } | null = null
  private stopListening: (() => void) | null = null
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
  }

  get available(): boolean {
    return !!EMULATOR || !!(config.apiKey && config.projectId)
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
    if (this.records && this.keys) await deleteDoc(doc(this.records, documentId(this.keys, 'device', this.saved.deviceId))).catch(() => {})
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
    if (!this.records || !this.keys) return
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
    const batch = writeBatch(this.records.firestore)
    batch.set(doc(this.records, docId), { v: PROTOCOL_VERSION, c: seal(this.keys, docId, record), t: serverTimestamp() })
    await batch.commit()
  }

  /** Before quitting: the window's last changes, and this computer's tabs. */
  async flush(): Promise<void> {
    if (!this.ready) return
    if (this.pushTimer) await this.push()
    await this.pushDevice(true)
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

  private connect(): { auth: Auth; db: Firestore } {
    if (this.services) return this.services
    const firebase = initializeApp(EMULATOR ? { apiKey: 'emulator', projectId: 'demo-zepper', appId: 'emulator' } : config, 'zepper-sync')
    const auth = initializeAuth(firebase, { persistence: filePersistence() })
    const db = initializeFirestore(firebase, {})
    if (EMULATOR) {
      connectAuthEmulator(auth, `http://${EMULATOR}:9099`, { disableWarnings: true })
      connectFirestoreEmulator(db, EMULATOR, 8080)
    }
    this.services = { auth, db }
    return this.services
  }

  private async begin(): Promise<void> {
    const secret = this.secret()
    if (!secret || !this.available) return
    this.stop()
    this.status = { kind: 'connecting' }
    this.changed()
    try {
      const { auth, db } = this.connect()
      if (!auth.currentUser) await signInAnonymously(auth)
      this.keys = deriveKeys(secret)
      this.records = collection(db, 'chains', this.keys.chainId, 'records')
      this.stopListening = onSnapshot(
        this.records,
        (snapshot) => this.received(snapshot),
        (error) => {
          this.status = { kind: 'error', message: error.message }
          this.changed()
        }
      )
    } catch (error) {
      this.status = { kind: 'error', message: (error as Error).message }
      this.changed()
    }
  }

  private stop(): void {
    this.stopListening?.()
    this.stopListening = null
    this.ready = false
    this.known.clear()
    this.devices.clear()
    if (this.pushTimer) clearTimeout(this.pushTimer)
    if (this.deviceTimer) clearTimeout(this.deviceTimer)
    this.pushTimer = this.deviceTimer = null
  }

  private received(snapshot: QuerySnapshot): void {
    if (!this.keys) return
    const changes: Change[] = []
    for (const change of snapshot.docChanges()) {
      const docId = change.doc.id
      const data = change.doc.data() as StoredRecord & { t?: Timestamp | null }
      const gone = change.type === 'removed' || !data.c
      const record = gone ? null : open(this.keys, docId, data.c!)
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
          void deleteDoc(change.doc.ref).catch(() => {})
        }
        continue
      }
      if (!record) {
        this.devices.delete(docId)
        const previous = this.known.get(docId)
        if (previous) changes.push({ record: null, previous })
        this.known.delete(docId)
        if (change.type !== 'removed' && data.t && Date.now() - data.t.toMillis() > TOMBSTONE_MS)
          void deleteDoc(change.doc.ref).catch(() => {})
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
    if (!this.window || !this.records || !this.keys) return
    const keys = this.keys
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
    const operations = [
      ...writes.map((w) => ({ docId: w.docId, data: { v: PROTOCOL_VERSION, c: seal(keys, w.docId, w.record), t: serverTimestamp() } })),
      ...deletes.map((docId) => ({ docId, data: { v: PROTOCOL_VERSION, c: null, t: serverTimestamp() } }))
    ]
    for (let i = 0; i < operations.length; i += BATCH) {
      const batch = writeBatch(this.records.firestore)
      for (const op of operations.slice(i, i + BATCH)) batch.set(doc(this.records, op.docId), op.data)
      await batch.commit().catch((error: Error) => {
        this.status = { kind: 'error', message: error.message }
        this.changed()
      })
    }
  }

  private async pushDevice(force: boolean): Promise<void> {
    if (!this.window || !this.records || !this.keys || !this.ready) return
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
    const batch = writeBatch(this.records.firestore)
    batch.set(doc(this.records, docId), { v: PROTOCOL_VERSION, c: seal(this.keys, docId, record), t: serverTimestamp() })
    await batch.commit().catch(() => {})
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

/**
 * Keeps the anonymous sign-in between launches (in sync-auth.json), so this computer stays the same
 * user rather than a new one each time. Firebase's own persistences are for browsers and React Native.
 */
function filePersistence(): Persistence {
  const file = new JsonFile<Record<string, unknown>>('sync-auth.json', 0)
  let data: Record<string, unknown> = file.read() ?? {}
  class FilePersistence {
    static type = 'LOCAL' as const
    readonly type = 'LOCAL' as const
    async _isAvailable(): Promise<boolean> {
      return true
    }
    async _set(key: string, value: unknown): Promise<void> {
      data = { ...data, [key]: value }
      file.schedule(data)
    }
    async _get(key: string): Promise<unknown> {
      return data[key] ?? null
    }
    async _remove(key: string): Promise<void> {
      const { [key]: _gone, ...rest } = data
      data = rest
      file.schedule(data)
    }
    _addListener(): void {}
    _removeListener(): void {}
  }
  return FilePersistence as unknown as Persistence
}
