import { DurableObject } from 'cloudflare:workers'

/**
 * Zepper Sync's server: a mailbox for each chain, holding what its devices sealed (see docs/SYNC.md).
 * It never sees a key: records are opaque ids and ciphertext, and a device proves it's in the chain
 * with a token derived from the sync code, which the server keeps only a hash of.
 *
 * A chain is a Durable Object (named by its chain id) with its records in SQLite. Devices connect
 * over a WebSocket: each gets every record on connecting, then every change as it's made, its own
 * included. Deletions are kept 30 days, so devices that were away hear of them, then go.
 */

interface Env {
  CHAINS: DurableObjectNamespace<Chain>
}

const CHAIN_ID = /^[A-Za-z0-9_-]{22}$/
const DOC_ID = /^[A-Za-z0-9_-]{22}$/
const SEALED = /^[A-Za-z0-9_-]+$/
const TOKEN = /^[A-Za-z0-9_-]{43}$/

/** A sealed record's size, at most (a device's 60 open tabs take about 12 KB). */
const MAX_SEALED = 64 * 1024
const MAX_DOCS_PER_MESSAGE = 500
const MAX_DOCS = 20_000
/** Records per message when sending a chain to a device that just connected. */
const SNAPSHOT_CHUNK = 200
const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    const match = pathname.match(/^\/v1\/chains\/([^/]+)$/)
    if (!match) return new Response('Zepper Sync\n', { status: pathname === '/' ? 200 : 404 })
    if (!CHAIN_ID.test(match[1])) return new Response('Not a chain id\n', { status: 400 })
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Connect with a WebSocket\n', { status: 426 })
    return env.CHAINS.get(env.CHAINS.idFromName(match[1])).fetch(request)
  }
}

/** What a device sends. */
type ClientMessage =
  | { op: 'hello'; v: number; token: string }
  | { op: 'put'; id: number; docs: { doc: string; c: string | null }[] }
  | { op: 'remove'; id: number; docs: string[] }

type Row = {
  doc: string
  c: string | null
  t: number
}

export class Chain extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec('CREATE TABLE IF NOT EXISTS records (doc TEXT PRIMARY KEY, c TEXT, t INTEGER NOT NULL)')
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    // Devices check the connection is alive with "ping"; answered without waking the chain.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ authed: false })
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    let message: ClientMessage
    try {
      message = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)) as ClientMessage
    } catch {
      return this.refuse(socket, 'Not JSON')
    }
    const { authed } = socket.deserializeAttachment() as { authed: boolean }
    if (message.op === 'hello') return this.hello(socket, message)
    if (!authed) return this.refuse(socket, 'Say hello first')
    if (message.op === 'put') return this.put(socket, message)
    if (message.op === 'remove') return this.remove(socket, message)
    this.refuse(socket, 'Unknown message')
  }

  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    try {
      socket.close(code === 1005 ? 1000 : code, 'Closed')
    } catch {
      // Already closed.
    }
  }

  /** A device joins: it proves it has the code, then gets the whole chain. */
  private async hello(socket: WebSocket, message: Extract<ClientMessage, { op: 'hello' }>): Promise<void> {
    if (message.v !== 1) return this.refuse(socket, 'This Zepper is newer than the server', 4400)
    if (typeof message.token !== 'string' || !TOKEN.test(message.token)) return this.refuse(socket, 'Not a token', 4400)
    const hash = await sha256(message.token)
    const known = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'token'").toArray()[0]?.value
    // The first device to arrive sets it: a chain id alone doesn't get anyone in.
    if (!known) this.sql.exec("INSERT INTO meta (key, value) VALUES ('token', ?)", hash)
    else if (known !== hash) return this.refuse(socket, 'Not this chain’s code', 4403)
    socket.serializeAttachment({ authed: true })
    const rows = this.sql.exec<Row>('SELECT doc, c, t FROM records').toArray()
    for (let i = 0; i < rows.length || i === 0; i += SNAPSHOT_CHUNK) {
      const records = rows.slice(i, i + SNAPSHOT_CHUNK)
      socket.send(JSON.stringify({ op: 'records', records, done: i + SNAPSHOT_CHUNK >= rows.length }))
    }
  }

  private put(socket: WebSocket, message: Extract<ClientMessage, { op: 'put' }>): void {
    const docs = Array.isArray(message.docs) ? message.docs : []
    if (docs.length > MAX_DOCS_PER_MESSAGE) return this.refuse(socket, 'Too many at once')
    for (const { doc, c } of docs) {
      if (typeof doc !== 'string' || !DOC_ID.test(doc)) return this.refuse(socket, 'Not a document id')
      if (c !== null && (typeof c !== 'string' || c.length > MAX_SEALED || !SEALED.test(c)))
        return this.refuse(socket, 'Not a sealed record')
    }
    const count = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM records').one().n
    if (count + docs.length > MAX_DOCS) return this.refuse(socket, 'This chain is full')
    const records: Row[] = []
    for (const { doc, c } of docs) {
      const t = this.now()
      this.sql.exec(
        'INSERT INTO records (doc, c, t) VALUES (?, ?, ?) ON CONFLICT(doc) DO UPDATE SET c = excluded.c, t = excluded.t',
        doc,
        c,
        t
      )
      records.push({ doc, c, t })
    }
    socket.send(JSON.stringify({ op: 'ack', id: message.id }))
    if (records.length) this.broadcast({ op: 'changes', records })
    if (records.some((r) => r.c === null)) void this.cleanUpLater()
  }

  /** Gone for good (a sent tab, once opened; a device that left). */
  private remove(socket: WebSocket, message: Extract<ClientMessage, { op: 'remove' }>): void {
    const docs = Array.isArray(message.docs) ? message.docs.filter((doc) => typeof doc === 'string' && DOC_ID.test(doc)) : []
    if (docs.length > MAX_DOCS_PER_MESSAGE) return this.refuse(socket, 'Too many at once')
    const removed = docs.filter((doc) => this.sql.exec('DELETE FROM records WHERE doc = ?', doc).rowsWritten > 0)
    socket.send(JSON.stringify({ op: 'ack', id: message.id }))
    if (removed.length) this.broadcast({ op: 'changes', removed })
  }

  /** Daily, while there are deletions: those everyone has had 30 days to hear of go. */
  async alarm(): Promise<void> {
    const cutoff = Date.now() - TOMBSTONE_MS
    const removed = this.sql
      .exec<{ doc: string }>('DELETE FROM records WHERE c IS NULL AND t < ? RETURNING doc', cutoff)
      .toArray()
      .map((r) => r.doc)
    if (removed.length) this.broadcast({ op: 'changes', removed })
    const left = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM records WHERE c IS NULL').one().n
    if (left > 0) await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
  }

  private async cleanUpLater(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
  }

  /** Write times always move forward, even within one millisecond. */
  private now(): number {
    const last = Number(this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'last'").toArray()[0]?.value ?? 0)
    const t = Math.max(Date.now(), last + 1)
    this.sql.exec("INSERT INTO meta (key, value) VALUES ('last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(t))
    return t
  }

  private broadcast(message: unknown): void {
    const text = JSON.stringify(message)
    for (const socket of this.ctx.getWebSockets()) {
      if (!(socket.deserializeAttachment() as { authed: boolean }).authed) continue
      try {
        socket.send(text)
      } catch {
        // It's going away.
      }
    }
  }

  private refuse(socket: WebSocket, message: string, code = 4400): void {
    try {
      socket.send(JSON.stringify({ op: 'error', message }))
      socket.close(code, message)
    } catch {
      // Already closed.
    }
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
