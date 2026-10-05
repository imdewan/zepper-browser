import { useRef, useState } from 'react'
import {
  HARMONIES,
  THEME_PRESETS,
  dotsForTheme,
  harmoniesFor,
  harmonyDots,
  themeBackground,
  themeFromDots,
  wheelColor,
  wheelPoint
} from '@shared/theme'
import type { Harmony, SpaceTheme } from '@shared/types'
import { IconMinus, IconPlus } from './icons'
import { cx } from './util'

/** Fraction of the field the colour wheel's radius covers. */
const WHEEL = 0.44

interface GradientEditorProps {
  theme: SpaceTheme
  onChange: (theme: SpaceTheme) => void
}

/**
 * Gradient editor. Drag the large dot around the colour wheel;
 * the smaller dots follow according to the colour harmony. Up to three
 * colours, with intensity, grain and a light/dark mode for the space.
 */
export function GradientEditor({ theme, onChange }: GradientEditorProps): React.JSX.Element {
  const [local, setLocal] = useState(theme)
  const [dragging, setDragging] = useState(false)
  const field = useRef<HTMLDivElement>(null)
  const frame = useRef(0)
  const pending = useRef<SpaceTheme | null>(null)

  // Follow outside changes (another window, undo) when not mid-drag.
  const [followed, setFollowed] = useState(theme)
  if (theme !== followed && !dragging) {
    setFollowed(theme)
    setLocal(theme)
  }

  const dots = dotsForTheme(local)
  const harmony: Harmony = local.harmony && HARMONIES[local.harmony].offsets.length === dots.length - 1
    ? local.harmony
    : (harmoniesFor(Math.max(1, dots.length))[0] ?? 'floating')

  /** Applies locally right away and forwards at most once per frame. */
  const update = (next: SpaceTheme): void => {
    setLocal(next)
    pending.current = next
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      if (pending.current) onChange(pending.current)
    })
  }

  const pointFromEvent = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = field.current!.getBoundingClientRect()
    const radius = rect.width * WHEEL
    let x = (e.clientX - (rect.left + rect.width / 2)) / radius
    let y = (e.clientY - (rect.top + rect.height / 2)) / radius
    const r = Math.hypot(x, y)
    if (r > 1) {
      x /= r
      y /= r
    }
    return { x, y }
  }

  const movePrimary = (point: { x: number; y: number }): void => {
    const h = dots.length === 0 ? 'floating' : harmony
    update(themeFromDots(local, harmonyDots(point, h), h))
  }

  const setCount = (count: number): void => {
    if (count <= 0) {
      update({ ...local, colors: [], dots: [], harmony: 'floating' })
      return
    }
    const next = harmoniesFor(count)[0]
    update(themeFromDots(local, harmonyDots(dots[0] ?? { x: 0.55, y: -0.35 }, next), next))
  }

  const cycleHarmony = (): void => {
    const options = harmoniesFor(dots.length)
    if (options.length < 2) return
    const next = options[(options.indexOf(harmony) + 1) % options.length]
    update(themeFromDots(local, harmonyDots(dots[0], next), next))
  }

  return (
    <div className="gradient-editor">
      <div
        ref={field}
        className={cx('wheel-field', dragging && 'dragging')}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragging(true)
          movePrimary(pointFromEvent(e))
        }}
        onPointerMove={(e) => dragging && movePrimary(pointFromEvent(e))}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId)
          setDragging(false)
        }}
      >
        <div className="wheel" />
        <svg className="wheel-links" viewBox="-1 -1 2 2" preserveAspectRatio="none">
          {dots.slice(1).map((d, i) => (
            <line
              key={i}
              x1={dots[0].x * WHEEL * 2}
              y1={dots[0].y * WHEEL * 2}
              x2={d.x * WHEEL * 2}
              y2={d.y * WHEEL * 2}
            />
          ))}
        </svg>
        {dots.map((d, i) => (
          <span
            key={i}
            className={cx('wheel-dot', i === 0 && 'primary')}
            style={{
              left: `${50 + d.x * WHEEL * 100}%`,
              top: `${50 + d.y * WHEEL * 100}%`,
              background: wheelColor(d.x, d.y)
            }}
          />
        ))}
        {dots.length === 0 && <div className="wheel-hint">Click to pick a colour</div>}
      </div>

      <div className="wheel-toolbar">
        <button className="wheel-tool" title="Remove a colour" disabled={dots.length === 0} onClick={() => setCount(dots.length - 1)}>
          <IconMinus size={14} />
        </button>
        <button className="wheel-harmony" disabled={harmoniesFor(dots.length).length < 2} onClick={cycleHarmony} title="Change colour harmony">
          {dots.length === 0 ? 'Default' : HARMONIES[harmony].label}
        </button>
        <button className="wheel-tool" title="Add a colour" disabled={dots.length >= 3} onClick={() => setCount(dots.length + 1)}>
          <IconPlus size={14} />
        </button>
      </div>

      <div className="segmented wide">
        {(['auto', 'light', 'dark'] as const).map((scheme) => (
          <button
            key={scheme}
            className={cx((local.scheme ?? 'auto') === scheme && 'selected')}
            onClick={() => update({ ...local, scheme })}
          >
            {scheme === 'auto' ? 'Auto' : scheme === 'light' ? 'Light' : 'Dark'}
          </button>
        ))}
      </div>

      <label className="slider-row">
        <span>Intensity</span>
        <input
          type="range"
          min={0.2}
          max={0.9}
          step={0.01}
          value={local.opacity}
          disabled={dots.length === 0}
          onChange={(e) => update({ ...local, opacity: Number(e.target.value) })}
        />
      </label>
      <label className="slider-row">
        <span>Grain</span>
        <input
          type="range"
          min={0}
          max={1}
          step={1 / 16}
          value={local.texture}
          onChange={(e) => update({ ...local, texture: Number(e.target.value) })}
        />
      </label>

      <div className="swatches">
        {THEME_PRESETS.map((preset, i) => (
          <button
            key={i}
            className={cx(
              'swatch',
              preset.colors.join() === local.colors.join() && 'selected',
              preset.colors.length === 0 && 'swatch-default'
            )}
            style={{ background: preset.colors.length ? themeBackground({ ...preset, opacity: 1 }) : undefined }}
            onClick={() => {
              const presetDots = preset.colors.map(wheelPoint)
              update({
                ...local,
                colors: preset.colors,
                dots: presetDots,
                harmony: harmoniesFor(Math.max(1, presetDots.length))[0],
                opacity: preset.colors.length ? preset.opacity : local.opacity,
                texture: preset.texture
              })
            }}
          />
        ))}
      </div>
    </div>
  )
}
