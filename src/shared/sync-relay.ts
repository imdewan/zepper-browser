/**
 * Zepper Sync's connection to its server (sync-server/ in the desktop app's repository): a chain's
 * records as they change, and writes to them. This file is the same in the desktop app
 * (src/shared/sync-relay.ts) and the iPhone app (src/sync/relay.ts). See docs/SYNC.md.
 *
 * It keeps the chain as the server has it and reports what changed in it, as a live query would:
 * the whole chain when it first connects, then each change. Writes made while it's offline go out
 * once it's back, and it reconnects by itself, the chain then coming in again (only what differs is
 * reported).
 */

/** A document as the server has it: the sealed record (null once deleted) and when it last changed. */
export interface RelayDoc {
  c: string | null
  /** The server's time of the last write (ms since 1970). */
  t: number
}

export interface RelayChange {
  type: 'added' | 'modified' | 'removed'
  doc: string
  data: RelayDoc
}

export interface RelayHandlers {
  /** What changed: everything there is, the first time. */
  changes(changes: RelayChange[]): void
  /** Connected and up to date, or not (reconnecting); `error` when the server refused. */
  status(status: { kind: 'connecting' } | { kind: 'connected' } | { kind: 'error'; message: string }): void
}

type ServerMessage =
  | { op: 'records'; records: ({ doc: string } & RelayDoc)[]; done: boolean }
  | { op: 'changes'; records?: ({ doc: string } & RelayDoc)[]; removed?: string[] }
  | { op: 'ack'; id: number }
  | { op: 'error'; message: string }

interface Pending {
  message: { op: 'put' | 'remove'; id: number; docs: unknown[] }
  resolve: () => void
}

/** Between tries to reconnect, at most. */
const MAX_RETRY_MS = 30_000
/** How often the connection is checked (a phone that slept may have lost it without hearing). */
const PING_MS = 25_000
const PONG_MS = 10_000

export class Relay {
  private socket: WebSocket | null = null
  private docs = new Map<string, RelayDoc>()
  /** The chain coming in as the connection opens. */
  private loading: Map<string, RelayDoc> | null = null
  private synced = false
  private pending = new Map<number, Pending>()
  private nextId = 1
  private retries = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  /** The chain's address on the server: wss://…/v1/chains/{chainId}. */
  private readonly url: string
  /** Proves this device has the chain's code (ChainKeys.access). */
  private readonly token: string
  private readonly handlers: RelayHandlers

  constructor(url: string, token: string, handlers: RelayHandlers) {
    this.url = url
    this.token = token
    this.handlers = handlers
  }

  start(): void {
    this.closed = false
    this.connect()
  }

  close(): void {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.stopPinging()
    const socket = this.socket
    this.socket = null
    socket?.close(1000, 'Done')
  }

  /** Back right away (the app came to the front, the network changed), if it's waiting to retry. */
  wake(): void {
    if (this.closed || this.socket) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.connect()
  }

  /** Writes sealed records (null: deleted, kept a while so others hear). Resolves once the server has them. */
  put(docs: { doc: string; c: string | null }[]): Promise<void> {
    return this.send('put', docs)
  }

  /** Removes documents for good. */
  remove(docs: string[]): Promise<void> {
    return this.send('remove', docs)
  }

  private send(op: 'put' | 'remove', docs: unknown[]): Promise<void> {
    if (docs.length === 0) return Promise.resolve()
    return new Promise((resolve) => {
      const id = this.nextId++
      const message = { op, id, docs }
      this.pending.set(id, { message, resolve })
      if (this.synced) this.socket?.send(JSON.stringify(message))
    })
  }

  private connect(): void {
    this.handlers.status({ kind: 'connecting' })
    let socket: WebSocket
    try {
      socket = new WebSocket(this.url)
    } catch {
      return this.retry()
    }
    this.socket = socket
    this.synced = false
    socket.onopen = () => {
      socket.send(JSON.stringify({ op: 'hello', v: 1, token: this.token }))
      this.startPinging(socket)
    }
    socket.onmessage = (event) => {
      if (event.data === 'pong') {
        if (this.pongTimer) clearTimeout(this.pongTimer)
        this.pongTimer = null
        return
      }
      let message: ServerMessage
      try {
        message = JSON.parse(String(event.data)) as ServerMessage
      } catch {
        return
      }
      this.received(message)
    }
    socket.onclose = () => this.lost(socket)
    socket.onerror = () => {
      // onclose follows.
    }
  }

  private received(message: ServerMessage): void {
    if (message.op === 'error') {
      this.closed = true
      this.handlers.status({ kind: 'error', message: message.message })
      return
    }
    if (message.op === 'ack') {
      this.pending.get(message.id)?.resolve()
      this.pending.delete(message.id)
      return
    }
    if (message.op === 'records') {
      this.loading ??= new Map()
      for (const { doc, c, t } of message.records) this.loading.set(doc, { c, t })
      if (!message.done) return
      const next = this.loading
      this.loading = null
      const changes: RelayChange[] = []
      for (const [doc, data] of next) {
        const before = this.docs.get(doc)
        if (!before) changes.push({ type: 'added', doc, data })
        else if (before.c !== data.c || before.t !== data.t) changes.push({ type: 'modified', doc, data })
      }
      for (const [doc, data] of this.docs) if (!next.has(doc)) changes.push({ type: 'removed', doc, data })
      this.docs = next
      this.synced = true
      this.retries = 0
      this.handlers.changes(changes)
      this.handlers.status({ kind: 'connected' })
      // What was written while offline (or not yet acknowledged), in order.
      for (const { message: pending } of this.pending.values()) this.socket?.send(JSON.stringify(pending))
      return
    }
    // Changes as they're made, ours included.
    const changes: RelayChange[] = []
    for (const { doc, c, t } of message.records ?? []) {
      changes.push({ type: this.docs.has(doc) ? 'modified' : 'added', doc, data: { c, t } })
      this.docs.set(doc, { c, t })
    }
    for (const doc of message.removed ?? []) {
      const data = this.docs.get(doc)
      if (!data) continue
      this.docs.delete(doc)
      changes.push({ type: 'removed', doc, data })
    }
    if (changes.length) this.handlers.changes(changes)
  }

  /** The connection's gone: try again, unless we closed it. */
  private lost(socket: WebSocket): void {
    if (this.socket !== socket) return
    this.socket = null
    this.synced = false
    this.loading = null
    this.stopPinging()
    if (!this.closed) this.retry()
  }

  private retry(): void {
    this.handlers.status({ kind: 'connecting' })
    const delay = Math.min(MAX_RETRY_MS, 1000 * 2 ** this.retries) * (0.75 + Math.random() / 2)
    this.retries = Math.min(this.retries + 1, 10)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.closed) this.connect()
    }, delay)
  }

  private startPinging(socket: WebSocket): void {
    this.stopPinging()
    this.pingTimer = setInterval(() => {
      if (this.pongTimer) return
      socket.send('ping')
      // No answer: the connection's gone without saying so.
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null
        socket.close(4000, 'No answer')
        this.lost(socket)
      }, PONG_MS)
    }, PING_MS)
  }

  private stopPinging(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.pingTimer = this.pongTimer = null
  }
}
