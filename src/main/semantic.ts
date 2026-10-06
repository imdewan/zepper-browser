import type { HistoryEntry } from '@shared/types'
import { intelligence } from './ai'
import type { History } from './history'
import { JsonFile } from './persist'

/**
 * Search history by meaning. Each page you visit gets a vector from Apple's on-device embedding
 * model (its title and opening text), so "that article about async Rust" finds a page titled
 * "Pinning futures with Tokio". Apple Intelligence then picks the real matches from the
 * closest ones. Pages leave this index when they leave history.
 */

interface Note {
  title: string
  host: string
  /** The opening of the page's text, for the model to judge matches by. */
  text: string
  /** Base64 Float32 vector, once embedded. */
  vector?: string
  at: number
}

interface Stored {
  model: string
  notes: Record<string, Note>
}

const MAX_NOTES = 4000
const BATCH = 32
/** Pages re-noted after this long (titles and content change). */
const RENOTE_MS = 6 * 60 * 60 * 1000

function decode(base64: string): Float32Array {
  const bytes = Buffer.from(base64, 'base64')
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

export class SemanticHistory {
  private readonly file = new JsonFile<Stored>('history-meaning.json', 60_000)
  private data: Stored
  private readonly queue = new Set<string>()
  private embedding = false
  private timer: NodeJS.Timeout | null = null
  /** Decoded vectors, kept while the index is in use. */
  private vectors = new Map<string, Float32Array>()

  constructor(private readonly history: History) {
    this.data = this.file.read() ?? { model: '', notes: {} }
    for (const [url, note] of Object.entries(this.data.notes)) if (!note.vector) this.queue.add(url)
    history.onForget((urls) => this.forget(urls))
  }

  /** A page finished loading: remember what it's about (if it's new, or it's been a while). */
  note(url: string, title: string, text: string): void {
    if (!/^https?:/.test(url)) return
    const existing = this.data.notes[url]
    if (existing && Date.now() - existing.at < RENOTE_MS && existing.title === title) return
    let host: string
    try {
      host = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return
    }
    this.data.notes[url] = { title, host, text: text.replace(/\s+/g, ' ').trim().slice(0, 600), at: Date.now() }
    this.vectors.delete(url)
    this.queue.add(url)
    this.trim()
    this.schedule(15_000)
  }

  /** Pages matching what you remember, best first (empty if this Mac can't do it). */
  async search(query: string, limit = 8): Promise<HistoryEntry[]> {
    const status = await intelligence.status()
    if (!status.embeddings || query.trim().length < 3) return []
    await this.embedPending()
    const { vectors } = await intelligence.request<{ model: string; vectors: (string | null)[] }>('embed', { texts: [query] })
    if (!vectors[0]) return []
    const q = decode(vectors[0])
    const entries = Object.entries(this.data.notes).filter(([url, note]) => note.vector && this.history.has(url))
    if (entries.length === 0) return []
    // Centre the vectors on their mean: raw sentence vectors all point roughly the same way.
    const docs = entries.map(([url, note]) => [url, this.vector(url, note.vector!)] as const)
    const mean = new Float32Array(q.length)
    for (const [, v] of docs) for (let i = 0; i < mean.length; i++) mean[i] += v[i] / docs.length
    const scored = docs
      .map(([url, v]) => ({ url, score: centredCosine(q, v, mean) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 24)
    let order = scored.map((s) => s.url)
    if (status.ai) {
      try {
        const items = order.map((url) => ({
          title: this.data.notes[url].title,
          host: this.data.notes[url].host,
          text: this.data.notes[url].text
        }))
        const ranked = await intelligence.request<{ order: number[] }>('rank', { query, items }, undefined, 20_000)
        order = ranked.order.map((i) => order[i]).filter(Boolean)
      } catch {
        // Fall back to the embedding order.
      }
    }
    return order.slice(0, limit).flatMap((url) => {
      const visit = this.history.get(url)
      return visit ? [{ url, title: visit.title || this.data.notes[url].title, lastVisit: visit.lastVisit, visits: visit.visits }] : []
    })
  }

  flush(): void {
    this.file.flush()
  }

  private vector(url: string, base64: string): Float32Array {
    let v = this.vectors.get(url)
    if (!v) {
      v = decode(base64)
      this.vectors.set(url, v)
    }
    return v
  }

  private forget(urls: string[]): void {
    for (const url of urls) {
      delete this.data.notes[url]
      this.vectors.delete(url)
      this.queue.delete(url)
    }
    this.file.schedule(this.data)
  }

  private trim(): void {
    const urls = Object.keys(this.data.notes)
    if (urls.length <= MAX_NOTES) return
    const oldest = urls.sort((a, b) => this.data.notes[a].at - this.data.notes[b].at).slice(0, urls.length - MAX_NOTES)
    this.forget(oldest)
  }

  private schedule(delay: number): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.embedPending()
    }, delay)
  }

  /** Embeds queued pages in batches, in the background. */
  private async embedPending(): Promise<void> {
    if (this.embedding || this.queue.size === 0) return
    if (!(await intelligence.status()).embeddings) return
    this.embedding = true
    try {
      while (this.queue.size > 0) {
        const batch = [...this.queue].slice(0, BATCH)
        const texts = batch.map((url) => {
          const note = this.data.notes[url]
          return note ? `${note.title}. ${note.host}. ${note.text}` : ''
        })
        const result = await intelligence.request<{ model: string; vectors: (string | null)[] }>('embed', { texts })
        // A different embedding model can't be compared with the old vectors: start over.
        if (this.data.model && result.model && result.model !== this.data.model) {
          for (const [url, note] of Object.entries(this.data.notes)) {
            delete note.vector
            this.queue.add(url)
          }
          this.vectors.clear()
        }
        this.data.model = result.model
        batch.forEach((url, i) => {
          this.queue.delete(url)
          const note = this.data.notes[url]
          if (note && result.vectors[i]) note.vector = result.vectors[i]!
        })
        this.file.schedule(this.data)
      }
    } catch (error) {
      console.warn('[history] embedding failed', error)
    } finally {
      this.embedding = false
    }
  }
}

function centredCosine(a: Float32Array, b: Float32Array, mean: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - mean[i]
    const y = b[i] - mean[i]
    dot += x * y
    na += x * x
    nb += y * y
  }
  return dot / Math.max(Math.sqrt(na * nb), 1e-9)
}
