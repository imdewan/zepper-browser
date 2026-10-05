import { app, type WebContents } from 'electron'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { Command, Rect } from '@shared/types'

export interface DebugTarget {
  layers(): { name: string; webContents: WebContents; bounds: Rect }[]
  handle(command: Command): void
  snapshotJson(): unknown
  /** Sends synthetic precise (trackpad) wheel events to the active page. */
  wheel(dx: number, steps: number, layer: string, at: [number, number] | null): void
  /** Sends a mouse drag (or click when from === to) to a layer, in window coordinates. */
  drag(layer: string, from: [number, number], to: [number, number]): void
  /** Evaluates JavaScript in the active page and returns the result. */
  evaluate(code: string): Promise<unknown>
  /** Internal state that snapshots don't carry (dialog queue, overlay). */
  state(): unknown
  /** Moves the mouse over a layer, in that layer's coordinates (hover testing). */
  move(layer: string, x: number, y: number): void
}

const LOCAL_HOSTS = ['127.0.0.1', 'localhost']

/** Captures may only be written to temporary folders. */
function captureRoots(): string[] {
  return [app.getPath('temp'), '/tmp', '/private/tmp'].map((dir) => resolve(dir))
}

/**
 * Development-only HTTP endpoint on localhost so automated checks can drive
 * the app: capture each layer (chrome, active tab, overlay) and send commands.
 * Never started in packaged builds.
 */
export function startDebugServer(target: DebugTarget): void {
  if (app.isPackaged) return
  const port = Number(process.env['ZEPPER_DEBUG_PORT'] ?? 9876)
  const server = createServer(async (req, res) => {
    // Only local tools (curl, scripts) may drive the app: web pages send Origin or Sec-Fetch-*
    // headers, and a DNS-rebinding page would arrive with a foreign Host.
    const host = req.headers.host ?? ''
    if (
      req.headers.origin ||
      req.headers['sec-fetch-site'] ||
      req.headers['sec-fetch-mode'] ||
      !LOCAL_HOSTS.some((h) => host === `${h}:${port}`)
    ) {
      res.statusCode = 403
      res.end()
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/move') {
        target.move(
          url.searchParams.get('layer') ?? 'overlay',
          Number(url.searchParams.get('x') ?? 0),
          Number(url.searchParams.get('y') ?? 0)
        )
        res.end('ok')
      } else if (url.pathname === '/state') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(target.state()))
      } else if (url.pathname === '/snapshot') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(target.snapshotJson()))
      } else if (url.pathname === '/command' && req.method === 'POST') {
        let body = ''
        for await (const chunk of req) body += chunk
        target.handle(JSON.parse(body) as Command)
        res.end('ok')
      } else if (url.pathname === '/wheel') {
        const x = url.searchParams.get('x')
        const y = url.searchParams.get('y')
        target.wheel(
          Number(url.searchParams.get('dx') ?? -20),
          Number(url.searchParams.get('steps') ?? 15),
          url.searchParams.get('layer') ?? 'tab',
          x && y ? [Number(x), Number(y)] : null
        )
        res.end('ok')
      } else if (url.pathname === '/eval' && req.method === 'POST') {
        let body = ''
        for await (const chunk of req) body += chunk
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(await target.evaluate(body)))
      } else if (url.pathname === '/drag') {
        const n = (k: string): number => Number(url.searchParams.get(k) ?? 0)
        target.drag(url.searchParams.get('layer') ?? 'overlay', [n('x1'), n('y1')], [n('x2') || n('x1'), n('y2') || n('y1')])
        res.end('ok')
      } else if (url.pathname === '/capture') {
        const dir = resolve(url.searchParams.get('dir') ?? app.getPath('temp'))
        if (!captureRoots().some((root) => dir === root || dir.startsWith(root + sep))) throw new Error('dir must be in a temporary folder')
        const layers = []
        for (const layer of target.layers()) {
          const image = await layer.webContents.capturePage()
          const file = join(dir, `layer-${layer.name}.png`)
          await writeFile(file, image.toPNG())
          layers.push({ name: layer.name, file, bounds: layer.bounds, scale: image.getSize().width / Math.max(1, layer.bounds.width) })
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(layers))
      } else {
        res.statusCode = 404
        res.end()
      }
    } catch (error) {
      res.statusCode = 500
      res.end(String(error))
    }
  })
  server.on('error', (error) => console.warn(`[zepper] debug server not started on port ${port}:`, error.message))
  server.listen(port, '127.0.0.1', () => console.info(`[zepper] debug server on http://127.0.0.1:${port}`))
}
