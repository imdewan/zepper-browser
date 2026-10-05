import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * Zepper's on-device intelligence: a small Swift helper (native/zepper-ai, built by
 * `npm run build:native`) that uses Apple's Foundation Models, NaturalLanguage and Translation
 * frameworks. It runs on demand, answers requests over stdin/stdout, and exits when idle.
 * Nothing leaves the Mac.
 */

export interface AiStatus {
  /** Apple Intelligence (Foundation Models) is available. */
  ai: boolean
  /** Why it isn't, when it isn't. */
  reason?: string
  /** On-device translation (macOS 26.4 and later). */
  translation: boolean
  /** On-device text embeddings (for searching history by meaning). */
  embeddings: boolean
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

const IDLE_MS = 3 * 60_000
const UNAVAILABLE: AiStatus = { ai: false, reason: 'Needs macOS 26 or later.', translation: false, embeddings: false }

interface Pending {
  resolve: (result: unknown) => void
  reject: (error: AiError) => void
  onPartial?: (text: string) => void
  timer: NodeJS.Timeout
}

class Intelligence {
  private child: ChildProcess | null = null
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private idleTimer: NodeJS.Timeout | null = null
  private statusCheck: Promise<AiStatus> | null = null

  private get helperPath(): string {
    return app.isPackaged ? join(process.resourcesPath, 'bin', 'zepper-ai') : join(app.getAppPath(), 'build', 'bin', 'zepper-ai')
  }

  /** What's available on this Mac (checked once). */
  status(): Promise<AiStatus> {
    this.statusCheck ??= existsSync(this.helperPath)
      ? this.request<AiStatus>('check', {}, undefined, 15_000).catch(() => UNAVAILABLE)
      : Promise.resolve(UNAVAILABLE)
    return this.statusCheck
  }

  /** Runs an operation; streaming ones call `onPartial` with the text so far. */
  request<T>(op: string, body: object, onPartial?: (text: string) => void, timeoutMs = 90_000): Promise<T> {
    if (process.platform !== 'darwin' || !existsSync(this.helperPath)) {
      return Promise.reject(new AiError('This needs macOS 26 or later.', 'unavailable'))
    }
    const child = this.ensure()
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AiError('That took too long. Try again?', 'timeout'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject, onPartial, timer })
      child.stdin?.write(JSON.stringify({ id, op, ...body }) + '\n')
      this.keepAlive()
    })
  }

  private ensure(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child
    const child = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'] })
    this.child = child
    createInterface({ input: child.stdout! }).on('line', (line) => this.receive(line))
    const lost = (): void => {
      if (this.child === child) this.child = null
      for (const [id, request] of this.pending) {
        clearTimeout(request.timer)
        request.reject(new AiError('Apple Intelligence stopped unexpectedly. Try again?', 'crashed'))
        this.pending.delete(id)
      }
    }
    child.on('exit', lost)
    child.on('error', lost)
    child.stdin?.on('error', () => {})
    return child
  }

  private receive(line: string): void {
    let message: { id?: number; partial?: string; result?: unknown; error?: string; code?: string }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const request = message.id !== undefined ? this.pending.get(message.id) : undefined
    if (!request) return
    if (message.partial !== undefined) return request.onPartial?.(message.partial)
    clearTimeout(request.timer)
    this.pending.delete(message.id!)
    if (message.error !== undefined) request.reject(new AiError(message.error, message.code))
    else request.resolve(message.result)
    this.keepAlive()
  }

  /** The helper exits after a few quiet minutes, freeing its memory. */
  private keepAlive(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.child?.kill()
    }, IDLE_MS)
  }
}

export const intelligence = new Intelligence()
