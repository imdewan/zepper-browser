import { useEffect, useRef, useState } from 'react'
import type { PopoverSpec } from '@shared/types'
import { zepper } from '../bridge'
import { cx } from '../util'

type Portrait = Extract<PopoverSpec, { kind: 'portrait' }>

/** What the page sits on: white, a colour from the slider (its hue), or your desktop picture. */
type Backdrop = { kind: 'white' } | { kind: 'color'; hue: number } | { kind: 'wallpaper' }

const KEY = 'zepper.portraitBackdrop'
const DEFAULT: Backdrop = { kind: 'color', hue: 350 }

function savedBackdrop(): Backdrop {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Backdrop | null
    if (value && (value.kind === 'white' || value.kind === 'wallpaper' || (value.kind === 'color' && Number.isFinite(value.hue))))
      return value
  } catch {
    // Nothing kept (or no storage): the default.
  }
  return DEFAULT
}

/**
 * Portrait Mode, as in Arc: the page as it is now, framed like a window on a background, for sharing
 * work in progress. The preview follows the background you pick; Capture puts the full-size picture
 * on the clipboard (with Save and Show in Finder, as any capture).
 */
export function PortraitPanel({ popover, onClose }: { popover: Portrait; onClose: () => void }): React.JSX.Element {
  const [backdrop, setBackdrop] = useState<Backdrop>(() => {
    const saved = savedBackdrop()
    return saved.kind === 'wallpaper' && !popover.wallpaper ? DEFAULT : saved
  })
  const page = useImage(popover.image)
  const wallpaper = useImage(popover.wallpaper)
  const preview = useRef<HTMLCanvasElement>(null)
  // The slider keeps its colour while white or the desktop picture is chosen.
  const [hue, setHue] = useState(() => (backdrop.kind === 'color' ? backdrop.hue : 350))

  const choose = (next: Backdrop): void => {
    setBackdrop(next)
    if (next.kind === 'color') setHue(next.hue)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // Remembered for this time only.
    }
  }

  useEffect(() => {
    const canvas = preview.current
    if (!canvas || !page) return
    const width = canvas.clientWidth
    const ratio = window.devicePixelRatio || 1
    draw(canvas, page, backdrop, wallpaper, (width * ratio) / framedWidth(page.naturalWidth, page.naturalHeight))
  }, [page, wallpaper, backdrop])

  const capture = (): void => {
    if (!page) return
    const canvas = document.createElement('canvas')
    draw(canvas, page, backdrop, wallpaper, 1)
    zepper.send({ type: 'developer.portraitDone', png: canvas.toDataURL('image/png'), scale: popover.scale })
    onClose()
  }

  const aspect = page ? framedHeight(page.naturalWidth, page.naturalHeight) / framedWidth(page.naturalWidth, page.naturalHeight) : 0.62

  return (
    <div className="portrait">
      <button className="portrait-capture" onClick={capture} disabled={!page}>
        Capture in Portrait Mode
      </button>
      <canvas ref={preview} className="portrait-preview" style={{ aspectRatio: `${1 / aspect}` }} />
      <div className="portrait-backdrops">
        <button
          className={cx('portrait-swatch', 'white', backdrop.kind === 'white' && 'on')}
          title="White"
          onClick={() => choose({ kind: 'white' })}
        />
        <input
          className={cx('portrait-hue', backdrop.kind === 'color' && 'on')}
          type="range"
          min={0}
          max={359}
          value={Math.round(hue)}
          title="Colour"
          onChange={(e) => choose({ kind: 'color', hue: Number(e.target.value) })}
          onPointerDown={() => backdrop.kind !== 'color' && choose({ kind: 'color', hue })}
        />
        {popover.wallpaper && (
          <button
            className={cx('portrait-swatch', 'wallpaper', backdrop.kind === 'wallpaper' && 'on')}
            title="Your desktop picture"
            style={{ backgroundImage: `url(${popover.wallpaper})` }}
            onClick={() => choose({ kind: 'wallpaper' })}
          />
        )}
      </div>
    </div>
  )
}

function useImage(src: string | null): HTMLImageElement | null {
  const [loaded, setLoaded] = useState<{ src: string; image: HTMLImageElement } | null>(null)
  useEffect(() => {
    if (!src) return
    const img = new Image()
    img.onload = () => setLoaded({ src, image: img })
    img.src = src
  }, [src])
  return src && loaded?.src === src ? loaded.image : null
}

/** Room around the window: a share of its larger side. */
const margin = (w: number, h: number): number => Math.round(Math.max(w, h) * 0.07)
const framedWidth = (w: number, h: number): number => w + 2 * margin(w, h)
const framedHeight = (w: number, h: number): number => h + 2 * margin(w, h)

/**
 * The page framed on its background, `k` times its own size: a rounded window with a soft shadow
 * and a hairline edge, on white, a two-tone gradient of the hue, or the desktop picture (filling it).
 */
function draw(canvas: HTMLCanvasElement, page: HTMLImageElement, backdrop: Backdrop, wallpaper: HTMLImageElement | null, k: number): void {
  const w = page.naturalWidth
  const h = page.naturalHeight
  const pad = margin(w, h)
  canvas.width = Math.round(framedWidth(w, h) * k)
  canvas.height = Math.round(framedHeight(w, h) * k)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width
  const H = canvas.height
  ctx.imageSmoothingQuality = 'high'

  if (backdrop.kind === 'wallpaper' && wallpaper) {
    const scale = Math.max(W / wallpaper.naturalWidth, H / wallpaper.naturalHeight)
    const dw = wallpaper.naturalWidth * scale
    const dh = wallpaper.naturalHeight * scale
    ctx.drawImage(wallpaper, (W - dw) / 2, (H - dh) / 2, dw, dh)
  } else if (backdrop.kind === 'color') {
    const gradient = ctx.createLinearGradient(0, 0, W, H)
    gradient.addColorStop(0, `hsl(${backdrop.hue} 88% 66%)`)
    gradient.addColorStop(1, `hsl(${(backdrop.hue + 32) % 360} 92% 72%)`)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, W, H)
    // A soft light from the top left.
    const light = ctx.createRadialGradient(W * 0.2, H * 0.1, 0, W * 0.2, H * 0.1, Math.max(W, H) * 0.8)
    light.addColorStop(0, 'rgba(255, 255, 255, 0.28)')
    light.addColorStop(1, 'rgba(255, 255, 255, 0)')
    ctx.fillStyle = light
    ctx.fillRect(0, 0, W, H)
  } else {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, W, H)
  }

  const x = pad * k
  const y = pad * k
  const pw = w * k
  const ph = h * k
  const radius = Math.max(w, h) * 0.008 * k + 6 * k
  const shape = (): void => {
    ctx.beginPath()
    ctx.roundRect(x, y, pw, ph, radius)
  }
  ctx.save()
  ctx.shadowColor = backdrop.kind === 'white' ? 'rgba(20, 24, 40, 0.18)' : 'rgba(20, 24, 40, 0.3)'
  ctx.shadowBlur = pad * k * 0.55
  ctx.shadowOffsetY = pad * k * 0.16
  shape()
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.restore()
  ctx.save()
  shape()
  ctx.clip()
  ctx.drawImage(page, x, y, pw, ph)
  ctx.restore()
  shape()
  ctx.lineWidth = Math.max(1, k)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.1)'
  ctx.stroke()
}
