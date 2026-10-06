import type { WebContents } from 'electron'
import { crc32 } from 'node:zlib'

/**
 * Screen captures (⇧⌘2): what the capture mode needs from the page, full-page capture over the
 * DevTools protocol, and PNG density metadata so Retina captures open at their real size.
 */

/** The page's elements on screen (for hover snapping), its scroll position, and whether it scrolls. */
export const CAPTURE_TARGETS_SCRIPT = `(() => {
  const vw = innerWidth
  const vh = innerHeight
  const targets = []
  const all = document.body ? document.body.getElementsByTagName('*') : []
  for (let i = 0; i < all.length && targets.length < 4000; i++) {
    const el = all[i]
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'BR') continue
    const r = el.getBoundingClientRect()
    if (r.width < 40 || r.height < 16 || r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.opacity === '0') continue
    targets.push([r.left, r.top, r.width, r.height])
  }
  const doc = document.scrollingElement || document.documentElement
  return { targets, scrollX, scrollY, viewport: [vw, vh], scrolls: doc.scrollHeight > vh + 4 || doc.scrollWidth > vw + 4 }
})()`

export interface CaptureTargets {
  targets: [number, number, number, number][]
  scrollX: number
  scrollY: number
  viewport: [number, number]
  scrolls: boolean
}

/** The whole page, beyond the screen (Chromium sizes the capture itself). */
export async function captureFullPage(wc: WebContents): Promise<Buffer> {
  return withDebugger(wc, async () => {
    const result = (await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })) as {
      data: string
    }
    return Buffer.from(result.data, 'base64')
  })
}

/** Part of the page in document coordinates (CSS pixels), even where it's off screen. */
export async function captureArea(wc: WebContents, clip: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  return withDebugger(wc, async () => {
    const result = (await wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { ...clip, scale: 1 }
    })) as { data: string }
    return Buffer.from(result.data, 'base64')
  })
}

async function withDebugger<T>(wc: WebContents, run: () => Promise<T>): Promise<T> {
  // An open DevTools window doesn't conflict; only our own earlier attach would.
  const attached = wc.debugger.isAttached()
  if (!attached) wc.debugger.attach('1.3')
  try {
    return await run()
  } finally {
    if (!attached && wc.debugger.isAttached()) wc.debugger.detach()
  }
}

/**
 * Marks a PNG with its pixel density (a pHYs chunk), so a 2× capture opens at its real size in
 * Preview, Slack and the like instead of twice as large.
 */
export function pngWithDensity(png: Buffer, scale: number): Buffer {
  const IHDR_END = 8 + 25
  if (scale <= 1 || png.length < IHDR_END || png.toString('latin1', 12, 16) !== 'IHDR') return png
  if (png.includes(Buffer.from('pHYs'))) return png
  const pixelsPerMetre = Math.round((scale * 72) / 0.0254)
  const data = Buffer.alloc(9)
  data.writeUInt32BE(pixelsPerMetre, 0)
  data.writeUInt32BE(pixelsPerMetre, 4)
  data.writeUInt8(1, 8)
  const type = Buffer.from('pHYs', 'latin1')
  const chunk = Buffer.alloc(4 + 4 + 9 + 4)
  chunk.writeUInt32BE(9, 0)
  type.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0, 17)
  return Buffer.concat([png.subarray(0, IHDR_END), chunk, png.subarray(IHDR_END)])
}
