import { app, type WebContents } from 'electron'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Command, Rect } from '@shared/types'

export interface DebugTarget {
  layers(): { name: string; webContents: WebContents; bounds: Rect }[]
  handle(command: Command): void
  snapshotJson(): unknown
  /** Sends synthetic precise (trackpad) wheel events to the active page. */
  wheel(dx: number, steps: number): void
  /** Sends a mouse drag (or click when from === to) to a layer, in window coordinates. */
  drag(layer: string, from: [number, number], to: [number, number]): void
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
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/snapshot') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(target.snapshotJson()))
      } else if (url.pathname === '/command' && req.method === 'POST') {
        let body = ''
        for await (const chunk of req) body += chunk
        target.handle(JSON.parse(body) as Command)
        res.end('ok')
      } else if (url.pathname === '/wheel') {
        target.wheel(Number(url.searchParams.get('dx') ?? -20), Number(url.searchParams.get('steps') ?? 15))
        res.end('ok')
      } else if (url.pathname === '/drag') {
        const n = (k: string): number => Number(url.searchParams.get(k) ?? 0)
        target.drag(url.searchParams.get('layer') ?? 'overlay', [n('x1'), n('y1')], [n('x2') || n('x1'), n('y2') || n('y1')])
        res.end('ok')
      } else if (url.pathname === '/capture') {
        const dir = url.searchParams.get('dir') ?? app.getPath('temp')
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
  server.listen(port, '127.0.0.1', () => console.info(`[zepper] debug server on http://127.0.0.1:${port}`))
}
