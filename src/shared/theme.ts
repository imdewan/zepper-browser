import type { Harmony, SpaceTheme } from './types'

export const DEFAULT_THEME: SpaceTheme = { colors: [], opacity: 0.5, texture: 0 }

/** Curated gradient presets, offered when creating or editing a space. */
export const THEME_PRESET_GROUPS: { label: string; presets: SpaceTheme[] }[] = [
  {
    // Quiet, low-saturation tones that sit back behind your tabs.
    label: 'Subtle',
    presets: [
      { colors: [], opacity: 0.5, texture: 0 },
      { colors: ['#c8d4e3', '#e2e7ee'], opacity: 0.7, texture: 0 },
      { colors: ['#a9bccb', '#c9d6df', '#e4e9ed'], opacity: 0.65, texture: 0.05 },
      { colors: ['#bcd9df', '#d8e2f0'], opacity: 0.65, texture: 0 },
      { colors: ['#b8cbb9', '#d7e1d3'], opacity: 0.7, texture: 0.05 },
      { colors: ['#e2d3be', '#efe7da'], opacity: 0.7, texture: 0.05 },
      { colors: ['#c9c3e4', '#dddaef'], opacity: 0.7, texture: 0 },
      { colors: ['#c4bfdc', '#e2cdd3', '#f0dfd0'], opacity: 0.65, texture: 0.05 },
      { colors: ['#e5cad0', '#f0dfe1'], opacity: 0.7, texture: 0 },
      { colors: ['#3b4252', '#4c566a'], opacity: 0.75, texture: 0.1 },
      { colors: ['#1f2a3c', '#34445c'], opacity: 0.75, texture: 0.1 },
      { colors: ['#22332c', '#365246'], opacity: 0.75, texture: 0.1 }
    ]
  },
  {
    label: 'Vivid',
    presets: [
      { colors: ['#f4efdf'], opacity: 0.5, texture: 0 },
      { colors: ['#f0b8cd', '#e9c3e3'], opacity: 0.55, texture: 0 },
      { colors: ['#da7682', '#eb8570', '#dcce7f'], opacity: 0.55, texture: 0.15 },
      { colors: ['#5becad', '#7cc6e8'], opacity: 0.5, texture: 0 },
      { colors: ['#919bb5', '#c3b6e8', '#e8d3c3'], opacity: 0.55, texture: 0.1 },
      { colors: ['#7b6cf6', '#c06cf6', '#f66cb4'], opacity: 0.6, texture: 0.15 },
      { colors: ['#2d6cdf', '#1fb6c9'], opacity: 0.6, texture: 0 },
      { colors: ['#3fb6a8', '#4f7fe0', '#8a5cf0'], opacity: 0.6, texture: 0.1 },
      { colors: ['#3a7d44', '#9bc53d'], opacity: 0.55, texture: 0.1 },
      { colors: ['#e07a2d', '#f2b134'], opacity: 0.55, texture: 0 },
      { colors: ['#ff8a5c', '#ff5f8f', '#ffb86b'], opacity: 0.55, texture: 0.1 },
      { colors: ['#5b2a86', '#1b1f3b'], opacity: 0.7, texture: 0.2 }
    ]
  }
]

export const THEME_PRESETS: SpaceTheme[] = THEME_PRESET_GROUPS.flatMap((group) => group.presets)

export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.replace(/(.)/g, '$1$1') : value
  const n = parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function mix(hex: string, target: [number, number, number], amount: number): string {
  const rgb = hexToRgb(hex)
  return rgbToHex(rgb.map((c, i) => c + (target[i] - c) * amount) as [number, number, number])
}

/** Applies a space's light/dark mode to its colours: dark deepens them, light softens them. */
function schemeColors(theme: SpaceTheme): string[] {
  if (theme.scheme === 'dark') return theme.colors.map((c) => mix(c, [8, 8, 14], 0.5))
  if (theme.scheme === 'light') return theme.colors.map((c) => mix(c, [255, 255, 255], 0.35))
  return theme.colors
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return (
    '#' +
    [r, g, b]
      .map((v) =>
        Math.round(Math.max(0, Math.min(255, v)))
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  )
}

export function hslToHex(h: number, s: number, l: number): string {
  s /= 100
  l /= 100
  const k = (n: number): number => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return rgbToHex([f(0) * 255, f(8) * 255, f(4) * 255])
}

export function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l * 100]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s * 100, l * 100]
}

// ---- Colour wheel (gradient editor) ------------------------------------------
//
// Hue runs around the wheel (0° at the top, clockwise, matching a CSS conic
// gradient); distance from the centre runs from soft pastel to vivid.

export function wheelColor(x: number, y: number): string {
  const hue = ((Math.atan2(y, x) * 180) / Math.PI + 90 + 360) % 360
  const r = Math.min(1, Math.hypot(x, y))
  return hslToHex(hue, 25 + 75 * r, 88 - 36 * r)
}

export function wheelPoint(hex: string): { x: number; y: number } {
  const [h, s] = hexToHsl(hex)
  const r = Math.max(0.08, Math.min(1, (s - 25) / 75))
  const angle = ((h - 90) * Math.PI) / 180
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r }
}

/** Angle offsets (degrees) of the secondary dots for each colour harmony. */
export const HARMONIES: Record<Harmony, { label: string; offsets: number[] }> = {
  floating: { label: 'Single', offsets: [] },
  complementary: { label: 'Complementary', offsets: [180] },
  singleAnalogous: { label: 'Analogous pair', offsets: [310] },
  analogous: { label: 'Analogous', offsets: [50, 310] },
  triadic: { label: 'Triadic', offsets: [120, 240] },
  splitComplementary: { label: 'Split complementary', offsets: [150, 210] }
}

export function harmoniesFor(count: number): Harmony[] {
  return (Object.keys(HARMONIES) as Harmony[]).filter((h) => HARMONIES[h].offsets.length === count - 1)
}

/** Places the secondary dots around the primary one, at the same distance from the centre. */
export function harmonyDots(primary: { x: number; y: number }, harmony: Harmony): { x: number; y: number }[] {
  const r = Math.hypot(primary.x, primary.y)
  const base = Math.atan2(primary.y, primary.x)
  return [
    primary,
    ...HARMONIES[harmony].offsets.map((deg) => {
      const a = base + (deg * Math.PI) / 180
      return { x: Math.cos(a) * r, y: Math.sin(a) * r }
    })
  ]
}

/** Builds a theme from wheel dots, keeping intensity, grain and mode. */
export function themeFromDots(theme: SpaceTheme, dots: { x: number; y: number }[], harmony: Harmony): SpaceTheme {
  return { ...theme, dots, harmony, colors: dots.map((d) => wheelColor(d.x, d.y)) }
}

/** Dots for a theme that doesn't have editor state yet (presets, older themes). */
export function dotsForTheme(theme: SpaceTheme): { x: number; y: number }[] {
  return theme.dots ?? theme.colors.map(wheelPoint)
}

/**
 * Builds the CSS background for a space, with these shapes:
 * one colour is flat, two are crossing linear gradients, three add radial
 * highlights in the top corners.
 */
export function themeBackground(theme: SpaceTheme): string {
  const [c0, c1, c2] = schemeColors(theme).map((c) => rgba(c, theme.opacity))
  switch (theme.colors.length) {
    case 0:
      return 'transparent'
    case 1:
      return c0
    case 2:
      return `linear-gradient(150deg, ${c0} 30%, transparent 120%), linear-gradient(-30deg, ${c1} 30%, transparent 120%)`
    default:
      return `linear-gradient(-5deg, ${c2} 10%, transparent 80%), radial-gradient(circle at 95% 0%, ${c1} 0%, transparent 75%), radial-gradient(circle at 0% 0%, ${c0} 10%, transparent 70%)`
  }
}

function luminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/**
 * Whether chrome text should be light on this theme. The dominant colour is
 * blended over the platform material the way it appears on screen, then we
 * pick whichever of white or black text has more contrast, biased slightly
 * toward dark UI.
 */
export function prefersDarkUi(theme: SpaceTheme, systemDark: boolean): boolean {
  if (theme.scheme === 'dark') return true
  if (theme.scheme === 'light') return false
  if (theme.colors.length === 0) return systemDark
  const base: [number, number, number] = systemDark ? [30, 30, 32] : [236, 236, 238]
  const dominant = hexToRgb(theme.colors[0])
  const a = theme.opacity
  const mixed = dominant.map((c, i) => c * a + base[i] * (1 - a)) as [number, number, number]
  const lum = luminance(mixed)
  const contrastWhite = 1.05 / (lum + 0.05)
  const contrastBlack = (lum + 0.05) / 0.05
  return contrastWhite * 1.3 > contrastBlack
}

/** How well white text reads on a colour (WCAG contrast ratio). */
function contrastWithWhite(hex: string): number {
  return 1.05 / (luminance(hexToRgb(hex)) + 0.05)
}

/**
 * The accent for buttons, switches and highlights, in the dominant colour's hue. Pale or very dark
 * colours are pulled to a solid, saturated tone that white text reads on, so a filled button never
 * looks faded (or vanishes) whatever the theme. Greys use the system accent.
 */
export function themeAccent(theme: SpaceTheme): string | null {
  const dominant = theme.colors[0]
  if (!dominant) return null
  const [hue, saturation, lightness] = hexToHsl(dominant)
  if (saturation < 10) return null
  // Already solid enough: keep the colour you chose.
  if (contrastWithWhite(dominant) >= 3.3 && saturation >= 35 && lightness >= 30) return dominant
  const s = Math.min(Math.max(saturation, 55), 80)
  let l = Math.min(Math.max(lightness, 42), 58)
  let accent = hslToHex(hue, s, l)
  while (contrastWithWhite(accent) < 3.8 && l > 24) accent = hslToHex(hue, s, (l -= 2))
  return accent
}
